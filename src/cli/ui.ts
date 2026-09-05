/**
 * Terminal UI, Colors, Markdown Rendering, and Visual Elements.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { CliTaskItem } from './types'

// Terminal Color & Style Helpers
export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[38;2;59;130;246m', // #3b82f6 (Roxy Dark theme accent)
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[38;2;96;165;250m', // #60a5fa (Roxy Dark theme bright accent)
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // 24-bit brand colors (Roxy Dark signature theme palette)
  accent: '\x1b[38;2;59;130;246m',
  accentBright: '\x1b[38;2;96;165;250m',
  sky: '\x1b[38;2;147;197;253m', // #93c5fd soft blue / blush
  hair: '\x1b[38;2;96;165;250m', // #60a5fa Roxy periwinkle hair
  hairDark: '\x1b[38;2;37;99;235m', // #2563eb hair shadow & braid texture
  hat: '\x1b[38;2;67;56;202m', // #4338ca deep witch indigo hat
  hatBrim: '\x1b[38;2;79;70;229m', // #4f46e5 hat brim
  gold: '\x1b[38;2;245;158;11m', // #f59e0b amber hat band / buckle
  shadow: '\x1b[38;2;25;35;75m', // #19234b deep navy lineart
  skin: '\x1b[38;2;254;243;199m', // #fef3c7 anime skin tone
  eye: '\x1b[38;2;14;165;233m', // #0ea5e9 water magic blue eyes
  blush: '\x1b[38;2;244;114;182m', // #f472b6 soft blush
  mouth: '\x1b[38;2;251;113;133m', // #fb7185 cute smile
  tie: '\x1b[38;2;251;113;133m', // #fb7185 braid ribbon ties
  robe: '\x1b[38;2;30;41;59m', // #1e293b mage collar
  gem: '\x1b[38;2;56;189;248m', // #38bdf8 magic crystal brooch
  pink: '\x1b[38;2;244;114;182m',
  purple: '\x1b[38;2;192;132;252m',
  violet: '\x1b[38;2;168;85;247m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m'
}

/** Check if terminal supports Unicode symbols. Modern Windows 10/11 supports UTF-8. */
export const supportsUnicode = process.env.TERM !== 'dumb' && !process.env.NO_UNICODE

export const SYM = {
  bullet: supportsUnicode ? '●' : '*',
  check: supportsUnicode ? '✔' : '[OK]',
  cross: supportsUnicode ? '✖' : '[ERR]',
  arrow: supportsUnicode ? '→' : '->',
  pointer: supportsUnicode ? '❯' : '>',
  sparkle: supportsUnicode ? '✦' : '*',
  wrench: supportsUnicode ? '⚙' : '#',
  book: supportsUnicode ? '📖' : '[doc]',
  ellipsis: supportsUnicode ? '…' : '...',
  clock: supportsUnicode ? '⏳' : '[...]',
  circle: supportsUnicode ? '○' : '( )',
  corner: supportsUnicode ? '└─' : '\\-',
  line: supportsUnicode ? '─' : '-',
  bar: supportsUnicode ? '│' : '|',
  topCorner: supportsUnicode ? '╭─' : '+-',
  bottomCorner: supportsUnicode ? '╰─' : '+-'
}

/** Auto-detect current git branch in workspace (handles regular git repos & worktrees). */
export function detectGitBranch(cwd: string): string | undefined {
  try {
    const gitPath = path.join(cwd, '.git')
    if (fs.existsSync(gitPath)) {
      const stat = fs.statSync(gitPath)
      let headPath = path.join(gitPath, 'HEAD')
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf8')
        const match = content.match(/gitdir:\s*(.+)/i)
        if (match) {
          const rawDir = match[1].trim()
          const resolvedDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(cwd, rawDir)
          headPath = path.join(resolvedDir, 'HEAD')
        }
      }
      if (fs.existsSync(headPath)) {
        const head = fs.readFileSync(headPath, 'utf8').trim()
        if (head.startsWith('ref: refs/heads/')) {
          return head.slice('ref: refs/heads/'.length)
        }
        return head.slice(0, 7)
      }
    }
  } catch {
    // Ignore detection failure
  }
  return undefined
}

export interface BannerOptions {
  version: string
  cwd: string
  provider: string
  model: string
  branch?: string
  account?: string
  mode?: 'agent' | 'plan'
  autoApprove?: boolean
  padToBottom?: boolean
}

/** Display the charming Roxy CLI startup banner. */
export function printBanner(opts: BannerOptions): void {
  const branch = opts.branch || detectGitBranch(opts.cwd)
  const branchStr = branch ? ` ${C.magenta}git:(${branch})${C.reset}` : ''
  const providerLabel = opts.account || opts.provider

  let userName = ''
  try {
    const rawUser = (os.userInfo().username || '').trim()
    if (rawUser) {
      userName = rawUser.charAt(0).toUpperCase() + rawUser.slice(1)
    }
  } catch {
    // Ignore
  }

  const mascot = supportsUnicode
    ? [
        `        ${C.hat}▄█${C.reset}       `,
        `       ${C.hat}███▌${C.reset}      `,
        `      ${C.hat}█████${C.reset}      `,
        `     ${C.gold}███████${C.reset}     `,
        `  ${C.hatBrim}▄▄█████████▄▄${C.reset}  `,
        `  ${C.hair}█${C.hairDark}▓${C.hair}█${C.skin} ${C.eye}●${C.skin}   ${C.eye}●${C.skin} ${C.hair}█${C.hairDark}▓${C.hair}█${C.reset}  `,
        `  ${C.hair}██${C.skin} ${C.blush}·${C.skin}  ${C.mouth}v${C.skin}  ${C.blush}·${C.skin} ${C.hair}██${C.reset}  `,
        `  ${C.hairDark}▓█${C.reset}   ${C.robe}[${C.gem}✦${C.robe}]${C.reset}   ${C.hair}█${C.hairDark}▓${C.reset}  `,
        `  ${C.tie}▀▄${C.reset}         ${C.tie}▄▀${C.reset}  `
      ]
    : [
        '        /\       ',
        '       /  \      ',
        '      /____\     ',
        '     [======]    ',
        '   /__________\  ',
        '   (|  o  o  |)  ',
        '   (|  *  w  |)  ',
        '   /|   <>   |\  ',
        '   ()        ()  '
      ]

  const modeBadge =
    opts.mode === 'plan'
      ? `${C.yellow}● Plan Mode${C.dim} · read-only architecture & review${C.reset}`
      : `${C.cyan}● Agent Mode${C.dim} · autonomous tools & editing${C.reset}`

  const greeting = userName
    ? `${C.pink}✦${C.reset} ${C.italic}${C.dim}"Hi ${userName}! Ready to code and build with you."${C.reset}`
    : `${C.pink}✦${C.reset} ${C.italic}${C.dim}"Ready to code and build with you."${C.reset}`

  const meta = [
    `${C.bold}${C.white}Roxy ${C.pink}Code${C.reset}  ${C.dim}v${opts.version}${C.reset}`,
    `${C.white}${opts.model}${C.reset} ${C.dim}· ${providerLabel}${C.reset}`,
    `${C.gray}${opts.cwd}${C.reset}${branchStr}`,
    modeBadge,
    greeting,
    `${C.dim}Equipped with 10 tools, real-time LSP diagnostics, and OAuth intelligence.${C.reset}`,
    `${C.dim}Always by your side to design, write, test, and ship beautiful code.${C.reset}`
  ]

  console.log()
  const totalRows = Math.max(mascot.length, meta.length)
  for (let i = 0; i < totalRows; i++) {
    const m = mascot[i] || '                 '
    const t = meta[i] || ''
    console.log(`  ${m}   ${t}`)
  }

  // Dynamic vertical spacer: pushes divider, tips, and prompt to the very bottom
  if (opts.padToBottom && process.stdout.isTTY) {
    const termRows = process.stdout.rows || 24
    const headerRows = totalRows + 1
    const bottomRows = 4 // divider + suggestion + status bar + prompt
    const padLines = Math.max(1, termRows - headerRows - bottomRows)
    for (let i = 0; i < padLines; i++) {
      console.log()
    }
  } else {
    console.log()
  }

  const cols = Math.max(20, (process.stdout.columns || 80) - 4)
  const line = SYM.line.repeat(cols)

  console.log(`  ${C.dim}${line}${C.reset}`)

  const suggestions = [
    'fix typecheck errors',
    'explain this codebase architecture',
    'refactor and add unit tests',
    'review git diff and suggest improvements',
    'find and fix potential bugs'
  ]
  const sample = suggestions[Math.floor(Math.random() * suggestions.length)]

  console.log(
    `  ${C.brightCyan}${SYM.pointer}${C.reset} ${C.dim}Try${C.reset} ${C.italic}${C.gray}"${sample}"${C.reset}`
  )

  const autoState = opts.autoApprove
    ? `${C.green}auto mode on${C.reset}`
    : `${C.yellow}auto mode off${C.reset} ${C.dim}(type ${C.pink}/auto${C.dim} to toggle)${C.reset}`

  console.log(
    `  ${autoState} ${C.dim}· ${C.cyan}/help${C.dim} for commands · ${C.cyan}/mode${C.dim} to switch mode${C.reset}`
  )
}

/** Print the user's prompt in a distinctly styled block. */
export function printUserMessage(prompt: string): void {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  console.log()
  console.log(`${C.bold}${C.brightGreen}❯ You${C.reset} ${C.dim}· ${time}${C.reset}`)
  for (const line of prompt.split('\n')) {
    console.log(`  ${C.brightWhite}${line}${C.reset}`)
  }
  console.log()
}

/** Print the assistant header before streaming starts. */
export function printAssistantHeader(): void {
  console.log(`\n${C.bold}${C.brightCyan}✦ Roxy${C.reset} ${C.dim}· Agent${C.reset}\n`)
}

/** Print completion footer with timing and tokens. */
export function printTurnFooter(opts: {
  durationMs: number
  totalTokens?: number
  cost?: number
  model?: string
}): void {
  const durSec = (opts.durationMs / 1000).toFixed(1)
  const tokStr = opts.totalTokens ? `${opts.totalTokens.toLocaleString()} tokens` : ''
  const costStr = opts.cost ? `$${opts.cost.toFixed(4)}` : ''
  const modelName = opts.model ? opts.model.split('/').pop() : ''

  const parts = [`Done in ${durSec}s`, tokStr, costStr, modelName].filter(Boolean)
  const cols = Math.max(20, (process.stdout.columns || 80) - 4)
  const line = SYM.line.repeat(cols)
  console.log(`\n  ${C.dim}${line}${C.reset}`)
  console.log(`  ${C.dim}✦ ${parts.join(' · ')}${C.reset}`)
}

/** Simple interactive terminal spinner. */
export class Spinner {
  private timer: NodeJS.Timeout | null = null
  private frames = supportsUnicode
    ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['|', '/', '-', '\\']
  private frameIdx = 0
  private text: string
  private active = false

  constructor(text: string) {
    this.text = text
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.timer = setInterval(() => {
      const frame = this.frames[this.frameIdx % this.frames.length]
      this.frameIdx++
      process.stdout.write(`\r${C.cyan}${frame}${C.reset} ${C.dim}${this.text}${C.reset}\x1b[K`)
    }, 80)
  }

  update(newText: string): void {
    this.text = newText
  }

  stop(clear = true): void {
    if (!this.active) return
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.active = false
    if (clear) {
      process.stdout.write('\r\x1b[K')
    } else {
      process.stdout.write('\n')
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Format inline markdown (bold, code, italic). */
export function renderInlineMarkdown(text: string): string {
  let s = text
  s = s.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`)
  s = s.replace(/`([^`]+)`/g, `${C.magenta}$1${C.reset}`)
  s = s.replace(/\*([^*]+)\*/g, `${C.italic}$1${C.reset}`)
  return s
}

/** Render a formatted ASCII/Unicode boxed table from markdown rows. */
export function renderAsciiTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const isDelimiter = (r: string[]): boolean =>
    r.length > 0 && r.every((c) => /^:?-+:?$/.test(c.trim()))
  const cleanRows = rows.filter((r) => !isDelimiter(r))
  if (cleanRows.length === 0) return ''

  const numCols = Math.max(...cleanRows.map((r) => r.length))
  const colWidths: number[] = new Array(numCols).fill(0)

  for (const r of cleanRows) {
    for (let c = 0; c < numCols; c++) {
      const cell = r[c] ?? ''
      const plain = cell.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
      colWidths[c] = Math.min(Math.max(colWidths[c], plain.length), 45)
    }
  }

  const topBorder = `┌─${colWidths.map((w) => '─'.repeat(w)).join('─┬─')}─┐`
  const midBorder = `├─${colWidths.map((w) => '─'.repeat(w)).join('─┼─')}─┤`
  const botBorder = `└─${colWidths.map((w) => '─'.repeat(w)).join('─┴─')}─┘`

  const out: string[] = []
  out.push(`  ${C.dim}${topBorder}${C.reset}`)

  for (let rIdx = 0; rIdx < cleanRows.length; rIdx++) {
    const row = cleanRows[rIdx]
    const cells = colWidths.map((w, cIdx) => {
      const raw = row[cIdx] ?? ''
      const formatted = renderInlineMarkdown(raw)
      const plain = raw.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
      const pad = Math.max(0, w - plain.length)
      return formatted + ' '.repeat(pad)
    })
    const isHeader = rIdx === 0
    const rowStr = cells
      .map((c) => (isHeader ? `${C.bold}${c}${C.reset}` : c))
      .join(` ${C.dim}│${C.reset} `)
    out.push(`  ${C.dim}│${C.reset} ${rowStr} ${C.dim}│${C.reset}`)

    if (rIdx === 0 && cleanRows.length > 1) {
      out.push(`  ${C.dim}${midBorder}${C.reset}`)
    }
  }

  out.push(`  ${C.dim}${botBorder}${C.reset}`)
  return out.join('\n')
}

/**
 * Streaming Markdown Renderer that handles headers, lists, code boxes, and tables on the fly.
 */
export class StreamingMarkdownRenderer {
  private lineBuf = ''
  private inCodeBlock = false
  private codeLang = ''
  private tableBuf: string[][] = []

  write(chunk: string): void {
    this.lineBuf += chunk
    const lines = this.lineBuf.split('\n')
    this.lineBuf = lines.pop() ?? ''

    for (const line of lines) {
      this.processLine(line)
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim()

    // Table rows: | col | col |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
      this.tableBuf.push(cells)
      return
    } else if (this.tableBuf.length > 0) {
      this.flushTable()
    }

    // Code block toggle: ```lang
    if (trimmed.startsWith('```')) {
      if (!this.inCodeBlock) {
        this.inCodeBlock = true
        this.codeLang = trimmed.slice(3).trim()
        const label = this.codeLang ? ` [${this.codeLang}]` : ''
        process.stdout.write(`\n  ${C.dim}┌─${label}${C.reset}\n`)
      } else {
        this.inCodeBlock = false
        this.codeLang = ''
        process.stdout.write(`  ${C.dim}└─${C.reset}\n\n`)
      }
      return
    }

    // Inside code block
    if (this.inCodeBlock) {
      process.stdout.write(`  ${C.dim}│${C.reset}  ${C.brightCyan}${line}${C.reset}\n`)
      return
    }

    // Headers
    if (/^### (.*$)/.test(line)) {
      const title = line.replace(/^### /, '')
      process.stdout.write(`\n${C.bold}${C.yellow}◆ ${renderInlineMarkdown(title)}${C.reset}\n`)
      return
    }
    if (/^## (.*$)/.test(line)) {
      const title = line.replace(/^## /, '')
      process.stdout.write(`\n${C.bold}${C.brightCyan}■ ${renderInlineMarkdown(title)}${C.reset}\n`)
      return
    }
    if (/^# (.*$)/.test(line)) {
      const title = line.replace(/^# /, '')
      process.stdout.write(
        `\n${C.bold}${C.brightWhite}█ ${renderInlineMarkdown(title)}${C.reset}\n`
      )
      return
    }

    // Horizontal rule
    if (/^(\-{3,}|\*{3,})$/.test(trimmed)) {
      process.stdout.write(`\n  ${C.dim}${'─'.repeat(45)}${C.reset}\n\n`)
      return
    }

    // Bullet lists
    if (/^[\*\-]\s+(.*)$/.test(line)) {
      const item = line.replace(/^[\*\-]\s+/, '')
      process.stdout.write(`  ${C.cyan}${SYM.bullet}${C.reset} ${renderInlineMarkdown(item)}\n`)
      return
    }

    // Numbered lists
    if (/^\d+\.\s+(.*)$/.test(line)) {
      const numMatch = line.match(/^(\d+\.)\s+/)?.[1] || '1.'
      const item = line.replace(/^\d+\.\s+/, '')
      process.stdout.write(`  ${C.yellow}${numMatch}${C.reset} ${renderInlineMarkdown(item)}\n`)
      return
    }

    // Blockquotes
    if (/^>\s*(.*)$/.test(line)) {
      const quote = line.replace(/^>\s*/, '')
      process.stdout.write(
        `  ${C.dim}│${C.reset} ${C.italic}${renderInlineMarkdown(quote)}${C.reset}\n`
      )
      return
    }

    // Standard text line
    process.stdout.write(`${renderInlineMarkdown(line)}\n`)
  }

  private flushTable(): void {
    if (this.tableBuf.length > 0) {
      const rendered = renderAsciiTable(this.tableBuf)
      if (rendered) {
        process.stdout.write(rendered + '\n')
      }
      this.tableBuf = []
    }
  }

  flush(): void {
    if (this.tableBuf.length > 0) {
      this.flushTable()
    }
    if (this.lineBuf) {
      this.processLine(this.lineBuf)
      this.lineBuf = ''
    }
    if (this.inCodeBlock) {
      this.inCodeBlock = false
      process.stdout.write(`  ${C.dim}└─${C.reset}\n`)
    }
  }
}

/** Print a formatted Tool Start card. */
export function printToolStart(
  toolName: string,
  _id?: string,
  argsObj?: Record<string, unknown>
): void {
  let detail = ''
  if (argsObj) {
    if (toolName === 'read' || toolName === 'write' || toolName === 'edit' || toolName === 'lsp') {
      detail = String(argsObj.path ?? '')
    } else if (toolName === 'bash') {
      detail = String(argsObj.command ?? '')
    } else if (toolName === 'glob' || toolName === 'grep') {
      detail = `"${String(argsObj.pattern ?? '')}"`
    } else if (toolName === 'webfetch') {
      detail = String(argsObj.url ?? '')
    } else if (toolName === 'skill') {
      detail = String(argsObj.name ?? '')
    } else if (toolName === 'task') {
      detail = `[${argsObj.subagent_type || 'explore'}] ${argsObj.description || ''}`
    } else if (toolName === 'mcp') {
      detail = `${argsObj.action || ''} ${argsObj.id || ''}`.trim()
    }
  }

  const tag = `${C.bold}${C.yellow}[${toolName}]${C.reset}`
  const target = detail ? ` ${C.cyan}${detail}${C.reset}` : ''
  console.log(`\n  ${C.yellow}${SYM.wrench}${C.reset} ${tag}${target}`)
}

/** Print a formatted Tool Result card with informative summary. */
export function printToolEnd(
  toolName: string,
  ok: boolean,
  output: string,
  _argsObj?: Record<string, unknown>
): void {
  const icon = ok ? `${C.green}${SYM.check}${C.reset}` : `${C.red}${SYM.cross}${C.reset}`
  let summary = ''

  if (!ok) {
    const firstLine = (output || 'Failed').split('\n')[0]
    summary = `${icon} ${C.red}${firstLine}${C.reset}`
  } else {
    if (toolName === 'read') {
      const lineCount = output.split('\n').length
      summary = `${icon} ${C.dim}${lineCount} lines read (${formatBytes(output.length)})${C.reset}`
    } else if (toolName === 'write') {
      summary = `${icon} ${C.dim}Wrote ${formatBytes(output.length)}${C.reset}`
    } else if (toolName === 'edit') {
      summary = `${icon} ${C.dim}Applied changes${C.reset}`
    } else if (toolName === 'glob') {
      const files = output.trim() ? output.trim().split('\n') : []
      if (files.length === 1 && files[0] === 'No files matched.') {
        summary = `${icon} ${C.dim}No files matched${C.reset}`
      } else {
        summary = `${icon} ${C.dim}${files.length} file(s) found${C.reset}`
      }
    } else if (toolName === 'grep') {
      const matches = output.trim() ? output.trim().split('\n') : []
      summary = `${icon} ${C.dim}${matches.length} match(es)${C.reset}`
    } else if (toolName === 'bash') {
      const firstLine = output.trim().split('\n')[0] || 'Done'
      const preview = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
      summary = `${icon} ${C.dim}${preview}${C.reset}`
    } else if (toolName === 'lsp') {
      summary = `${icon} ${C.dim}Diagnostics checked${C.reset}`
    } else if (toolName === 'task') {
      summary = `${icon} ${C.dim}Subagent finished${C.reset}`
    } else {
      const firstLine = output.trim().split('\n')[0] || 'Done'
      const preview = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
      summary = `${icon} ${C.dim}${preview}${C.reset}`
    }
  }

  console.log(`    ${SYM.corner} ${summary}`)
}

/** Render a session task checklist. */
export function printTasksList(tasks: CliTaskItem[]): void {
  if (!tasks || tasks.length === 0) {
    console.log(`\n  ${C.dim}No tasks checklist in this session.${C.reset}\n`)
    return
  }

  console.log(`\n${C.bold}${C.cyan}Session Tasks (${tasks.length}):${C.reset}`)
  tasks.forEach((t, i) => {
    let statusIcon = `${C.dim}${SYM.circle}${C.reset}`
    let titleStr = t.title
    if (t.status === 'completed') {
      statusIcon = `${C.green}${SYM.check}${C.reset}`
      titleStr = `${C.dim}${t.title} (completed)${C.reset}`
    } else if (t.status === 'in_progress') {
      statusIcon = `${C.yellow}${SYM.clock}${C.reset}`
      titleStr = `${C.bold}${t.title} ${C.yellow}(in progress)${C.reset}`
    }
    console.log(`  ${statusIcon} ${i + 1}. ${titleStr}`)
  })
  console.log()
}
