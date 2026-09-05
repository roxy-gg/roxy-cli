/**
 * CLI Tool Engine: implements the standard Roxy toolset in pure Node.js.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'
import type { ToolDiff, ToolResult } from '../shared/types'
import type { WebFetchFormat } from '../shared/web'
import {
  BROWSER_UA,
  WEBFETCH_OUTPUT_CAP,
  WEBFETCH_TIMEOUT_DEFAULT,
  WEBFETCH_TIMEOUT_MAX,
  acceptHeader,
  convertWebContent,
  normalizeFetchUrl
} from '../shared/web'
import {
  loadSkill,
  listSkills,
  writeSkill,
  deleteSkill,
  installSkillFromSource
} from '../services/skills'
import {
  diagnostics as lspDiagnostics,
  diagnosticsBlock,
  shutdownAllLsp
} from '../services/lsp'
import { renderDiagnosticsBlock } from '../shared/lsp'
import {
  loadWorkspaceMcpServers,
  ensureMcpConnected,
  mcpToolSchemas,
  callMcpTool,
  isMcpTool,
  disposeConnection,
  reconnectMcpServer,
  shutdownAllMcp,
  mcpServerSummaries
} from '../services/mcp'
import { normalizeServerConfig, type McpServerRecord } from '../shared/mcp'
import type { CliToolDef } from './types'
import { formatDiffAnsi } from './diff'

const MAX_OUTPUT = 100_000
const MAX_READ_OUTPUT = 60_000

// Background processes registry
interface BackgroundProcess {
  id: string
  command: string
  child: ReturnType<typeof spawn>
  output: string
  running: boolean
  exitCode: number | null
  startedAt: number
}

const backgroundProcesses = new Map<string, BackgroundProcess>()
let bgCounter = 1

function killChildSafely(child: ReturnType<typeof spawn>): void {
  try {
    child.kill('SIGTERM')
  } catch {
    // Ignore
  }
}

function killProc(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' || !child.pid) {
    killChildSafely(child)
    return
  }
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  try {
    const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    killer.on('error', () => killChildSafely(child))
  } catch {
    killChildSafely(child)
  }
}

/**
 * Resolve a model-supplied path and CONFINE it to the workspace root.
 *
 * This is a security boundary, not a convenience helper: everything the model
 * asks to read or write flows through here. Absolute and relative paths are
 * resolved identically against the root, so neither `../../etc/passwd` nor
 * `/etc/passwd` can escape. Throws on any attempt to leave the workspace —
 * callers surface that as a failed tool result.
 */
function resolveWorkspacePath(cwd: string, filePath: string): string {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('A file path is required.')
  }
  // NUL bytes truncate paths in some syscalls — reject outright.
  if (filePath.includes('\0')) {
    throw new Error('Invalid path: contains a null byte.')
  }

  const root = path.resolve(cwd)
  const target = path.resolve(root, filePath)
  const rel = path.relative(root, target)

  // `rel` escapes the root when it starts with `..` or is itself absolute
  // (the latter happens across Windows drives, e.g. root C:\ vs target D:\).
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Path "${filePath}" is outside the workspace. ` +
        `Only paths under ${root} can be accessed.`
    )
  }
  return target
}

/**
 * Confine a path for WRITING. Same rules as reads, plus symlink resolution on
 * the nearest existing ancestor: without this, a symlink already inside the
 * workspace (`./link -> /etc`) would pass the textual check and then write
 * straight through it.
 */
async function resolveWritePath(cwd: string, filePath: string): Promise<string> {
  const target = resolveWorkspacePath(cwd, filePath)
  const root = await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd))

  // Walk up to the closest ancestor that exists, and check where it REALLY is.
  let probe = path.dirname(target)
  for (;;) {
    const real = await fs.realpath(probe).catch(() => null)
    if (real) {
      const rel = path.relative(root, real)
      if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new Error(
          `Path "${filePath}" resolves outside the workspace through a symlink.`
        )
      }
      break
    }
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  return target
}

/**
 * Confinement result: either a safe absolute path, or the reason it was
 * refused. Tools return the message as a failed ToolResult instead of throwing,
 * so a blocked path reads to the model as a normal tool failure it can recover
 * from rather than an exception.
 */
type Resolved = { path: string; error: null } | { path: string; error: string }

function tryResolvePath(cwd: string, filePath: string): Resolved {
  try {
    return { path: resolveWorkspacePath(cwd, filePath), error: null }
  } catch (e) {
    return { path: '', error: (e as Error).message }
  }
}

async function tryResolveWritePath(cwd: string, filePath: string): Promise<Resolved> {
  try {
    return { path: await resolveWritePath(cwd, filePath), error: null }
  } catch (e) {
    return { path: '', error: (e as Error).message }
  }
}

/**
 * Commands we refuse to run even when the user has auto-approve on.
 *
 * This is a backstop against prompt injection, not a complete sandbox: a
 * determined attacker can obfuscate around any regex. It exists so that the
 * common catastrophic one-liners can't fire unattended, which is exactly the
 * situation `-y` creates. Anything matched here always prompts, regardless of
 * autoApprove, and is refused outright in plan mode.
 */
const DENIED_COMMANDS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, why: 'recursive force delete' },
  { re: /\brm\s+(-\S+\s+)*(\/|~|\$HOME|\*)\s*$/, why: 'delete of root, home, or everything' },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|d|fi)?sh\b/i, why: 'pipe a remote script straight into a shell' },
  { re: /\b(sudo|doas|runas)\b/i, why: 'privilege escalation' },
  { re: /\bgit\s+push\b[^;|&]*--force\b(?!-with-lease)/i, why: 'force push (rewrites shared history)' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, why: 'discards uncommitted work irreversibly' },
  { re: /\b(mkfs(\.\w+)?|fdisk|diskpart)\b/i, why: 'disk formatting' },
  { re: /\bdd\b[^;|&]*\bof=\/dev\//i, why: 'raw write to a block device' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'shuts down the machine' },
  { re: /\bchmod\s+(-R\s+)?0?777\b/i, why: 'world-writable permissions' },
  { re: /\bnc\b[^;|&]*\s-e\b|\b(ba|z)?sh\s+-i\s*>&\s*\/dev\/tcp\//i, why: 'reverse shell' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, why: 'fork bomb' },
  { re: /\bhistory\s+-c\b|\b(Remove-Item|rm)\b[^;|&]*\.bash_history/i, why: 'covers its own tracks' }
]

/** Returns why a command is denied, or null when it passes screening. */
function screenCommand(cmd: string): string | null {
  for (const { re, why } of DENIED_COMMANDS) {
    if (re.test(cmd)) return why
  }
  return null
}

function toolDiff(filePath: string, before: string, after: string): ToolDiff | undefined {
  if (before === after) return undefined
  if (before.length > 200_000 || after.length > 200_000) return undefined
  return { path: filePath, before, after }
}

async function postFileMutationDiagnostics(abs: string, cwd: string): Promise<string> {
  try {
    const block = await diagnosticsBlock(abs, cwd)
    return block ? `\n\n${block}` : ''
  } catch {
    return ''
  }
}

export const CLI_TOOLS: Record<string, CliToolDef> = {
  read: {
    name: 'read',
    description: 'Read a file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace or absolute.' }
      },
      required: ['path']
    },
    mutates: false,
    run: async (input, ctx) => {
      const p = String(input.path ?? '').trim()
      if (!p) return { ok: false, output: 'Missing file path.' }
      const guard = tryResolvePath(ctx.cwd, p)
      if (guard.error) return { ok: false, output: guard.error }
      const resolved = guard.path
      try {
        const stat = await fs.stat(resolved)
        if (stat.isDirectory()) {
          return { ok: false, output: `Path "${p}" is a directory, not a file. Use list instead.` }
        }
        const text = await fs.readFile(resolved, 'utf8')
        if (text.length > MAX_READ_OUTPUT) {
          const preview = text.slice(0, MAX_READ_OUTPUT)
          return {
            ok: true,
            output: `File content truncated (${text.length} chars total):\n\n${preview}\n\n... [truncated. Use grep to find specific sections]`
          }
        }
        return { ok: true, output: text }
      } catch (e) {
        return { ok: false, output: `Error reading file "${p}": ${(e as Error).message}` }
      }
    }
  },

  write: {
    name: 'write',
    description: 'Create or overwrite a file with the given content. Creates parent folders.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
        content: { type: 'string', description: 'Full file content.' }
      },
      required: ['path', 'content']
    },
    mutates: true,
    run: async (input, ctx) => {
      const p = String(input.path ?? '').trim()
      const content = String(input.content ?? '')
      if (!p) return { ok: false, output: 'Missing file path.' }
      const guard = await tryResolveWritePath(ctx.cwd, p)
      if (guard.error) return { ok: false, output: guard.error }
      const resolved = guard.path

      let before = ''
      let existed = false
      try {
        before = await fs.readFile(resolved, 'utf8')
        existed = true
      } catch {
        // New file
      }

      if (ctx.askApproval && !ctx.autoApprove) {
        const preview = existed
          ? formatDiffAnsi(p, before, content)
          : `+ New file: ${p} (${content.length} bytes)`
        const decision = await ctx.askApproval('write', { path: p, bytes: content.length }, preview)
        if (decision === 'stop') return { ok: false, output: 'Operation stopped by user.' }
        if (decision === 'no') return { ok: false, output: `User declined writing to "${p}".` }
        if (decision === 'always') ctx.autoApprove = true
      }

      try {
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        await fs.writeFile(resolved, content, 'utf8')
        const diff = toolDiff(p, before, content)
        const diagBlock = await postFileMutationDiagnostics(resolved, ctx.cwd)
        return {
          ok: true,
          output: `Successfully wrote ${content.length} characters to "${p}".${diagBlock}`,
          diff
        }
      } catch (e) {
        return { ok: false, output: `Failed writing to "${p}": ${(e as Error).message}` }
      }
    }
  },

  edit: {
    name: 'edit',
    description: 'Replace an exact unique substring in a file with new text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        oldString: {
          type: 'string',
          description: 'Exact text to replace (must be unique in the file).'
        },
        newString: { type: 'string', description: 'Replacement text.' }
      },
      required: ['path', 'oldString', 'newString']
    },
    mutates: true,
    run: async (input, ctx) => {
      const p = String(input.path ?? '').trim()
      const oldStr = String(input.oldString ?? '')
      const newStr = String(input.newString ?? '')
      if (!p) return { ok: false, output: 'Missing file path.' }
      if (!oldStr) return { ok: false, output: 'Missing oldString to replace.' }
      const guard = await tryResolveWritePath(ctx.cwd, p)
      if (guard.error) return { ok: false, output: guard.error }
      const resolved = guard.path

      let content: string
      try {
        content = await fs.readFile(resolved, 'utf8')
      } catch (e) {
        return { ok: false, output: `File not found: "${p}" (${(e as Error).message})` }
      }

      const count = content.split(oldStr).length - 1
      if (count === 0) {
        return {
          ok: false,
          output: `oldString was not found in "${p}". Make sure indentation, whitespace, and newlines match exactly.`
        }
      }
      if (count > 1) {
        return {
          ok: false,
          output: `oldString occurs ${count} times in "${p}". Provide more surrounding context lines to make it unique.`
        }
      }

      const updated = content.replace(oldStr, newStr)

      if (ctx.askApproval && !ctx.autoApprove) {
        const preview = formatDiffAnsi(p, content, updated)
        const decision = await ctx.askApproval('edit', { path: p }, preview)
        if (decision === 'stop') return { ok: false, output: 'Operation stopped by user.' }
        if (decision === 'no') return { ok: false, output: `User declined edit to "${p}".` }
        if (decision === 'always') ctx.autoApprove = true
      }

      try {
        await fs.writeFile(resolved, updated, 'utf8')
        const diff = toolDiff(p, content, updated)
        const diagBlock = await postFileMutationDiagnostics(resolved, ctx.cwd)
        return {
          ok: true,
          output: `Edited "${p}".${diagBlock}`,
          diff
        }
      } catch (e) {
        return { ok: false, output: `Failed writing edit to "${p}": ${(e as Error).message}` }
      }
    }
  },

  list: {
    name: 'list',
    description: 'List the entries of a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default ".").' }
      }
    },
    mutates: false,
    run: async (input, ctx) => {
      const p = String(input.path ?? '.').trim() || '.'
      const guard = tryResolvePath(ctx.cwd, p)
      if (guard.error) return { ok: false, output: guard.error }
      const resolved = guard.path
      try {
        const entries = await fs.readdir(resolved, { withFileTypes: true })
        const dirs: string[] = []
        const files: string[] = []
        for (const entry of entries) {
          if (entry.isDirectory()) {
            dirs.push(`${entry.name}/`)
          } else {
            files.push(entry.name)
          }
        }
        dirs.sort()
        files.sort()
        const out = [...dirs, ...files].join('\n')
        return { ok: true, output: out || '(empty directory)' }
      } catch (e) {
        return { ok: false, output: `Error listing directory "${p}": ${(e as Error).message}` }
      }
    }
  },

  glob: {
    name: 'glob',
    description: 'Find files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' }
      },
      required: ['pattern']
    },
    mutates: false,
    run: async (input, ctx) => {
      const pattern = String(input.pattern ?? '').trim()
      if (!pattern) return { ok: false, output: 'Missing glob pattern.' }
      try {
        const matches = await glob(pattern, {
          cwd: ctx.cwd,
          dot: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**']
        })
        matches.sort()
        const count = matches.length
        if (count === 0) return { ok: true, output: 'No files matched.' }
        const text = matches.slice(0, 1000).join('\n')
        return {
          ok: true,
          output: count > 1000 ? `${text}\n... and ${count - 1000} more files` : text
        }
      } catch (e) {
        return { ok: false, output: `Glob error: ${(e as Error).message}` }
      }
    }
  },

  grep: {
    name: 'grep',
    description: 'Search file contents with a case-insensitive regex.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern.' },
        include: { type: 'string', description: 'Glob of files to search (default "**/*").' }
      },
      required: ['pattern']
    },
    mutates: false,
    run: async (input, ctx) => {
      const patternStr = String(input.pattern ?? '').trim()
      if (!patternStr) return { ok: false, output: 'Missing grep pattern.' }
      const includePattern = String(input.include ?? '**/*').trim() || '**/*'

      let regex: RegExp
      try {
        regex = new RegExp(patternStr, 'i')
      } catch (e) {
        return { ok: false, output: `Invalid regex pattern: ${(e as Error).message}` }
      }

      try {
        const files = await glob(includePattern, {
          cwd: ctx.cwd,
          onlyFiles: true,
          dot: false,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**']
        })

        const results: string[] = []
        let matchCount = 0
        const MAX_MATCHES = 100

        for (const file of files) {
          if (matchCount >= MAX_MATCHES) break
          const fullPath = path.resolve(ctx.cwd, file)
          let content = ''
          try {
            content = await fs.readFile(fullPath, 'utf8')
          } catch {
            continue
          }

          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${file}:${i + 1}: ${lines[i].trim()}`)
              matchCount++
              if (matchCount >= MAX_MATCHES) {
                results.push(`... reached cap of ${MAX_MATCHES} matches. Refine your query.`)
                break
              }
            }
          }
        }

        return {
          ok: true,
          output: results.length ? results.join('\n') : 'No matches found.'
        }
      } catch (e) {
        return { ok: false, output: `Grep error: ${(e as Error).message}` }
      }
    }
  },

  bash: {
    name: 'bash',
    description: 'Run a shell command in the workspace (PowerShell on Windows).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout: {
          type: 'number',
          description: 'Foreground timeout in seconds (default 60, max 600).'
        },
        background: {
          type: 'boolean',
          description: 'Run as long-lived background process (dev servers/watchers).'
        }
      },
      required: ['command']
    },
    mutates: true,
    run: async (input, ctx) => {
      const cmd = String(input.command ?? '').trim()
      if (!cmd) return { ok: false, output: 'Missing command.' }
      const isBg = Boolean(input.background)
      const timeoutSec = Math.min(Math.max(Number(input.timeout) || 60, 1), 600)

      // Screen BEFORE approval: a denied command must never be waved through
      // by `-y`, which is the exact case prompt injection targets.
      const denied = screenCommand(cmd)

      if (denied && ctx.mode === 'plan') {
        return {
          ok: false,
          output: `Refused in plan mode — command looks destructive (${denied}): "${cmd}"`
        }
      }

      if (ctx.askApproval && (!ctx.autoApprove || denied)) {
        const preview = denied
          ? `⚠ DESTRUCTIVE (${denied})\n$ ${cmd}${isBg ? ' & (background)' : ''}`
          : `$ ${cmd}${isBg ? ' & (background)' : ''}`
        const decision = await ctx.askApproval('bash', { command: cmd, background: isBg }, preview)
        if (decision === 'stop') return { ok: false, output: 'Operation stopped by user.' }
        if (decision === 'no') return { ok: false, output: `User declined command: "${cmd}".` }
        // A blanket "always" must not disarm the destructive-command screen.
        if (decision === 'always' && !denied) ctx.autoApprove = true
      } else if (denied && !ctx.askApproval) {
        return {
          ok: false,
          output:
            `Refused: command looks destructive (${denied}) and no approval channel ` +
            `is available to confirm it: "${cmd}"`
        }
      }

      const isWin = process.platform === 'win32'
      const shell = isWin ? 'powershell.exe' : '/bin/bash'
      const args = isWin
        ? ['-NoProfile', '-NonInteractive', '-Command', cmd]
        : ['-c', cmd]

      if (isBg) {
        const id = `bg_${bgCounter++}`
        try {
          const child = spawn(shell, args, {
            cwd: ctx.cwd,
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
            windowsHide: true
          })

          const bgEntry: BackgroundProcess = {
            id,
            command: cmd,
            child,
            output: '',
            running: true,
            exitCode: null,
            startedAt: Date.now()
          }

          child.stdout?.on('data', (d) => {
            bgEntry.output = (bgEntry.output + d.toString()).slice(-MAX_OUTPUT)
          })
          child.stderr?.on('data', (d) => {
            bgEntry.output = (bgEntry.output + d.toString()).slice(-MAX_OUTPUT)
          })
          child.on('close', (code) => {
            bgEntry.running = false
            bgEntry.exitCode = code
          })
          child.on('error', (err) => {
            bgEntry.running = false
            bgEntry.output += `\nProcess error: ${err.message}`
          })

          backgroundProcesses.set(id, bgEntry)
          return {
            ok: true,
            output: `Started background process ${id}: "${cmd}". Use bash_output to monitor or bash_kill to stop.`
          }
        } catch (e) {
          return {
            ok: false,
            output: `Failed to spawn background process: ${(e as Error).message}`
          }
        }
      }

      // Foreground process
      return new Promise<ToolResult>((resolve) => {
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(shell, args, {
            cwd: ctx.cwd,
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
            windowsHide: true
          })
        } catch (e) {
          return resolve({ ok: false, output: `Spawn error: ${(e as Error).message}` })
        }

        let output = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          killProc(child)
        }, timeoutSec * 1000)

        const onAbort = (): void => {
          killProc(child)
        }
        ctx.signal?.addEventListener('abort', onAbort, { once: true })

        child.stdout?.on('data', (chunk) => {
          const text = chunk.toString()
          output += text
          if (ctx.onChunk) ctx.onChunk(text)
        })

        child.stderr?.on('data', (chunk) => {
          const text = chunk.toString()
          output += text
          if (ctx.onChunk) ctx.onChunk(text)
        })

        child.on('close', (code) => {
          clearTimeout(timer)
          ctx.signal?.removeEventListener('abort', onAbort)
          if (timedOut) {
            return resolve({
              ok: false,
              output: `${output}\n\nCommand timed out after ${timeoutSec} seconds.`
            })
          }
          if (ctx.signal?.aborted) {
            return resolve({ ok: false, output: `${output}\n\nCommand stopped by user.` })
          }
          const ok = code === 0
          const trimmed = output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output
          resolve({
            ok,
            output:
              trimmed ||
              (ok ? '(command completed with no output)' : `(command failed with code ${code})`)
          })
        })

        child.on('error', (err) => {
          clearTimeout(timer)
          ctx.signal?.removeEventListener('abort', onAbort)
          resolve({ ok: false, output: `Command execution error: ${err.message}` })
        })
      })
    }
  },

  bash_list: {
    name: 'bash_list',
    description: 'List the running background processes.',
    parameters: {
      type: 'object',
      properties: {}
    },
    mutates: false,
    run: async () => {
      if (backgroundProcesses.size === 0) {
        return { ok: true, output: 'No background processes running.' }
      }
      const lines: string[] = []
      for (const [id, p] of backgroundProcesses.entries()) {
        const status = p.running ? 'running' : `exited (${p.exitCode})`
        const dur = Math.round((Date.now() - p.startedAt) / 1000)
        lines.push(`${id}: [${status}] (${dur}s) ${p.command}`)
      }
      return { ok: true, output: lines.join('\n') }
    }
  },

  bash_output: {
    name: 'bash_output',
    description: 'Read new output from a background process started by bash.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process ID (e.g. "bg_1").' }
      },
      required: ['id']
    },
    mutates: false,
    run: async (input) => {
      const id = String(input.id ?? '').trim()
      const p = backgroundProcesses.get(id)
      if (!p) return { ok: false, output: `No background process with id "${id}".` }
      const status = p.running ? 'running' : `exited (code ${p.exitCode})`
      const out = p.output || '(no output yet)'
      return { ok: true, output: `[Process ${id} is ${status}]\n${out}` }
    }
  },

  bash_kill: {
    name: 'bash_kill',
    description: 'Stop a background process started by bash.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process ID (e.g. "bg_1").' }
      },
      required: ['id']
    },
    mutates: true,
    run: async (input) => {
      const id = String(input.id ?? '').trim()
      const p = backgroundProcesses.get(id)
      if (!p) return { ok: false, output: `No background process with id "${id}".` }
      killProc(p.child)
      p.running = false
      backgroundProcesses.delete(id)
      return { ok: true, output: `Terminated background process "${id}".` }
    }
  },

  webfetch: {
    name: 'webfetch',
    description: 'Fetch a URL and return its contents as markdown, text, or HTML.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to fetch.' },
        format: { type: 'string', description: 'Format: "markdown", "text", or "html".' },
        timeout: { type: 'number', description: 'Timeout in seconds (max 120).' }
      },
      required: ['url']
    },
    mutates: false,
    run: async (input, ctx) => {
      const rawUrl = String(input.url ?? '').trim()
      if (!rawUrl) return { ok: false, output: 'Missing URL.' }
      const format =
        (String(input.format ?? 'markdown').toLowerCase() as WebFetchFormat) || 'markdown'
      const timeoutSec = Math.min(
        Math.max(Number(input.timeout) || WEBFETCH_TIMEOUT_DEFAULT, 1),
        WEBFETCH_TIMEOUT_MAX
      )

      let normUrl: string
      try {
        normUrl = normalizeFetchUrl(rawUrl)
      } catch (e) {
        return { ok: false, output: (e as Error).message }
      }

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000)
      const onAbort = (): void => ctrl.abort()
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true })

      try {
        const res = await fetch(normUrl, {
          headers: {
            'User-Agent': BROWSER_UA,
            Accept: acceptHeader(format)
          },
          signal: ctrl.signal
        })

        if (!res.ok) {
          return { ok: false, output: `HTTP error ${res.status}: ${res.statusText}` }
        }

        const contentType = res.headers.get('content-type') || 'text/html'
        const rawBody = await res.text()
        const converted = convertWebContent(rawBody, contentType, format)
        const capped =
          converted.length > WEBFETCH_OUTPUT_CAP
            ? converted.slice(0, WEBFETCH_OUTPUT_CAP) + '\n... [truncated]'
            : converted
        return { ok: true, output: capped }
      } catch (e) {
        return { ok: false, output: `Fetch error: ${(e as Error).message}` }
      } finally {
        clearTimeout(timer)
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort)
      }
    }
  },

  lsp: {
    name: 'lsp',
    description:
      'Report the language server diagnostics (type errors, unused symbols, unresolved imports, warnings) for a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace or absolute.' }
      },
      required: ['path']
    },
    mutates: false,
    run: async (input, ctx) => {
      const p = String(input.path ?? '').trim()
      if (!p) return { ok: false, output: 'Missing file path.' }
      const guard = tryResolvePath(ctx.cwd, p)
      if (guard.error) return { ok: false, output: guard.error }
      const resolved = guard.path
      try {
        const diags = await lspDiagnostics(resolved)
        if (diags.length === 0) return { ok: true, output: `No diagnostics reported for ${p}.` }
        const block = renderDiagnosticsBlock(p, diags, { includeWarnings: true, max: 50 })
        return { ok: true, output: block }
      } catch (e) {
        return { ok: false, output: `LSP error: ${(e as Error).message}` }
      }
    }
  },

  mcp: {
    name: 'mcp',
    description:
      'Manage external MCP (Model Context Protocol) tool servers for this workspace — add one, list them, (re)connect, enable/disable, or remove.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'reconnect', 'enable', 'disable', 'remove'],
          description: 'The management action to perform.'
        },
        id: { type: 'string', description: 'A short unique name for the server.' },
        command: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For a LOCAL stdio server on add: argv array, e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path"].'
        },
        url: {
          type: 'string',
          description: 'For a REMOTE HTTP/SSE server on add: the server URL.'
        },
        cwd: { type: 'string', description: 'Working directory for local server.' },
        env: { type: 'object', description: 'Environment variables for local server.' },
        headers: { type: 'object', description: 'HTTP headers for remote server.' }
      },
      required: ['action']
    },
    mutates: true,
    run: async (input, ctx) => {
      const action = String(input.action ?? '')
        .toLowerCase()
        .trim()
      if (action === 'list' || action === 'ls' || action === 'status') {
        const summaries = mcpServerSummaries()
        if (summaries.length === 0) return { ok: true, output: 'No MCP servers connected.' }
        const lines = summaries.map((s) => {
          const statusStr =
            s.status === 'connected' ? `connected (${s.tools.length} tools)` : s.status
          const toolList = s.tools.length ? `: ${s.tools.join(', ')}` : ''
          return `- ${s.id} [${statusStr}]${toolList}${s.error ? ` (error: ${s.error})` : ''}`
        })
        return { ok: true, output: lines.join('\n') }
      }

      const id = String(input.id ?? '').trim()
      if (!id) return { ok: false, output: 'Missing required "id" for server.' }

      if (action === 'add' || action === 'upsert' || action === 'create') {
        const config = normalizeServerConfig({
          type: input.url ? 'remote' : 'local',
          command: input.command,
          url: input.url,
          cwd: input.cwd,
          headers: input.headers,
          environment: input.env
        })
        if (!config) {
          return {
            ok: false,
            output: 'Invalid server configuration. Need "command" (array) or "url".'
          }
        }
        const record: McpServerRecord = { id, config, enabled: true }
        await ensureMcpConnected([record], ctx.cwd)
        const summary = mcpServerSummaries().find((s) => s.id === id)
        if (summary?.status === 'connected') {
          return {
            ok: true,
            output: `MCP server "${id}" connected. Registered tools: ${summary.tools.join(', ') || '(none)'}`
          }
        }
        return {
          ok: false,
          output: `Failed to connect MCP server "${id}": ${summary?.error || 'Unknown error'}`
        }
      }

      if (action === 'reconnect' || action === 'refresh') {
        const existing = mcpServerSummaries().find((s) => s.id === id)
        if (!existing) return { ok: false, output: `Server "${id}" not found.` }
        const res = await reconnectMcpServer(
          { id, config: { type: 'local', command: [] }, enabled: true },
          ctx.cwd
        )
        return {
          ok: res.status === 'connected',
          output:
            res.status === 'connected' ? `Reconnected "${id}".` : `Failed reconnect: ${res.error}`
        }
      }

      if (action === 'remove' || action === 'delete' || action === 'rm') {
        await disposeConnection(id)
        return { ok: true, output: `Disconnected and removed MCP server "${id}".` }
      }

      return { ok: false, output: `Unsupported action: ${action}` }
    }
  },

  task: {
    name: 'task',
    description:
      'Delegate a focused, self-contained sub-task to a specialized subagent that runs on its own and reports back. Use this to parallelize or offload work (e.g. research the codebase, build a page). The subagent has NO memory of this conversation, so put ALL the context it needs into `prompt`. It returns a single report.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short (3-5 word) label for the task.' },
        prompt: {
          type: 'string',
          description:
            'The complete task for the subagent, including every bit of context it needs.'
        },
        subagent_type: {
          type: 'string',
          enum: ['explore', 'general'],
          description:
            'Which subagent: "general" (full tools) or "explore" (read-only search/understanding).'
        },
        background: {
          type: 'boolean',
          description: 'Run detached (optional).'
        }
      },
      required: ['description', 'prompt', 'subagent_type']
    },
    mutates: false,
    run: async (input, ctx) => {
      const description = String(input.description ?? '').trim()
      const prompt = String(input.prompt ?? '').trim()
      let subagentType = String(input.subagent_type ?? 'explore').toLowerCase() as
        | 'explore'
        | 'general'
      if (ctx.mode === 'plan' && subagentType === 'general') {
        subagentType = 'explore'
      }
      if (!prompt) return { ok: false, output: 'Missing task prompt.' }

      if (ctx.runSubagent) {
        try {
          const report = await ctx.runSubagent(subagentType, description, prompt)
          return { ok: true, output: report }
        } catch (e) {
          return { ok: false, output: `Subagent failed: ${(e as Error).message}` }
        }
      }

      return { ok: false, output: 'Subagent execution is not available in this context.' }
    }
  },

  skill: {
    name: 'skill',
    description: 'Load a specialized SKILL.md on demand.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name.' }
      },
      required: ['name']
    },
    mutates: false,
    run: async (input, ctx) => {
      const name = String(input.name ?? '').trim()
      if (!name) return { ok: false, output: 'Missing skill name.' }
      return await loadSkill(name, ctx.cwd)
    }
  },

  skill_manage: {
    name: 'skill_manage',
    description: 'Create, install, edit, or delete reusable skills.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'install', 'list', 'edit', 'remove'] },
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        scope: { type: 'string', enum: ['workspace', 'global'] },
        source: { type: 'string' }
      },
      required: ['action']
    },
    mutates: true,
    run: async (input, ctx) => {
      const action = String(input.action ?? '').trim()
      if (action === 'list') {
        const skills = await listSkills(ctx.cwd)
        if (skills.length === 0) return { ok: true, output: 'No skills installed.' }
        const list = skills
          .map((s) => `- ${s.name} (${s.source}): ${s.description || '(no description)'}`)
          .join('\n')
        return { ok: true, output: list }
      }
      if (action === 'create' || action === 'edit') {
        const name = String(input.name ?? '').trim()
        const res = await writeSkill(
          {
            name,
            description: input.description ? String(input.description) : undefined,
            body: input.body ? String(input.body) : undefined,
            scope: (input.scope as 'workspace' | 'global') || 'workspace'
          },
          ctx.cwd,
          { mode: action === 'create' ? 'create' : 'edit' }
        )
        return {
          ok: res.ok,
          output: res.ok ? `Skill "${name}" saved to ${res.location}.` : `Error: ${res.error}`
        }
      }
      if (action === 'remove') {
        const name = String(input.name ?? '').trim()
        const res = await deleteSkill(name, ctx.cwd)
        return { ok: res.ok, output: res.ok ? `Skill "${name}" removed.` : `Error: ${res.error}` }
      }
      if (action === 'install') {
        const source = String(input.source ?? '').trim()
        const res = await installSkillFromSource(source, {
          cwd: ctx.cwd,
          scope: (input.scope as 'workspace' | 'global') || 'workspace'
        })
        return {
          ok: res.ok,
          output: res.ok
            ? `Installed ${res.installed.length} skill(s) from ${source}.`
            : `Install failed: ${res.error}`
        }
      }
      return { ok: false, output: `Unknown action: ${action}` }
    }
  },

  change_session_metadata: {
    name: 'change_session_metadata',
    description: 'Update session title, description, or task checklist.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Session title.' },
        description: { type: 'string', description: 'Session description.' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
            },
            required: ['title', 'status']
          }
        }
      }
    },
    mutates: false,
    run: async (input, ctx) => {
      const bits: string[] = []
      if (input.title) {
        const titleStr = String(input.title).trim()
        bits.push(`title: "${titleStr}"`)
        if (ctx.session) ctx.session.title = titleStr
      }
      if (input.tasks && Array.isArray(input.tasks)) {
        const tasks = input.tasks as Array<{
          title: string
          status: 'pending' | 'in_progress' | 'completed'
        }>
        bits.push(`${tasks.length} tasks`)
        if (ctx.session) ctx.session.tasks = tasks
      }
      return { ok: true, output: `Updated session metadata (${bits.join(', ') || 'no changes'}).` }
    }
  },

  browser_open: {
    name: 'browser_open',
    description: 'Open a URL in browser (desktop app feature; in CLI, use webfetch).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open.' } },
      required: ['url']
    },
    mutates: false,
    run: async () => ({
      ok: false,
      output:
        'Interactive GUI browser automation requires the Roxy Desktop app. In CLI mode, please use the "webfetch" tool to retrieve and read web pages directly.'
    })
  }
}

/** Get OpenAI-compatible function schema definitions for active tools. */
export function getCliToolSchemas(mode: 'agent' | 'plan' = 'agent'): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}> {
  const tools = Object.values(CLI_TOOLS).filter((t) => {
    if (mode === 'plan' && t.mutates) return false
    return true
  })

  const baseSchemas = tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))

  const mcpSchemas = mcpToolSchemas().map((s) => ({
    type: 'function' as const,
    function: {
      name: s.function.name,
      description: s.function.description || '',
      parameters: s.function.parameters
    }
  }))

  return [...baseSchemas, ...mcpSchemas]
}

/** Kill all background processes spawned by the CLI. */
export function killAllCliBackground(): void {
  for (const p of backgroundProcesses.values()) {
    killProc(p.child)
  }
  backgroundProcesses.clear()
}

export {
  lspDiagnostics,
  shutdownAllLsp,
  loadWorkspaceMcpServers,
  ensureMcpConnected,
  callMcpTool,
  isMcpTool,
  shutdownAllMcp
}
