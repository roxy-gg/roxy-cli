/**
 * CLI Slash Commands.
 * Handles /help, /model, /provider, /cost, /clear, /skills, /diff, /sessions, /mode, /tasks, /mcp, /tools, etc.
 */
import { execSync } from 'node:child_process'
import { C, SYM, printTasksList, printBanner } from './ui'
import type { CliProvider, CliSessionData } from './types'
import { listSkills } from '../services/skills'
import { mcpServerSummaries } from '../services/mcp'
import { getCliToolSchemas } from './tools'
import { CLI_VERSION } from './version'
import { saveSession, listRecentSessions } from './session'
import {
  compactSessionConversation,
  getModelContextLimit,
  estimateSessionTokens
} from './compaction'
import { DEFAULT_MODELS, saveStoredConfig } from './config'
import {
  listOAuthAccounts,
  runSidecarOAuthLogin,
  ensureOAuthSidecarRunning,
  getSidecarModels
} from './oauth'

export interface CommandContext {
  session: CliSessionData
  cwd: string
  autoApprove: boolean
  setAutoApprove: (val: boolean) => void
  setProvider: (p: CliProvider) => void
  setModel: (m: string) => void
  setMode?: (m: 'agent' | 'plan') => void
  exit: () => void
  apiKey?: string
  baseUrl?: string
}

export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<void> | void

export const COMMANDS: Record<string, { desc: string; run: CommandHandler }> = {
  help: {
    desc: 'Show available slash commands and keybindings',
    run: () => {
      console.log(`\n${C.bold}${C.cyan}Available Slash Commands:${C.reset}`)
      console.log(`  ${C.yellow}/help${C.reset}             Show this help message`)
      console.log(`  ${C.yellow}/model [name]${C.reset}     View or switch the active model`)
      console.log(
        `  ${C.yellow}/models${C.reset}           List available models for current provider`
      )
      console.log(
        `  ${C.yellow}/provider [name]${C.reset}  Switch AI provider (antigravity, claude, codex, anthropic, openai, etc.)`
      )
      console.log(
        `  ${C.yellow}/mode [name]${C.reset}      Switch mode: 'agent' (full) or 'plan' (read-only)`
      )
      console.log(
        `  ${C.yellow}/tasks${C.reset}            Display active task checklist for this session`
      )
      console.log(
        `  ${C.yellow}/oauth${C.reset}            List active OAuth subscriptions (Google, Claude, ChatGPT)`
      )
      console.log(
        `  ${C.yellow}/login [name]${C.reset}    Log in via OAuth in browser (antigravity, claude, codex)`
      )
      console.log(
        `  ${C.yellow}/mcp${C.reset}              List connected MCP servers and their tools`
      )
      console.log(`  ${C.yellow}/tools${C.reset}            List all active agent tools`)
      console.log(
        `  ${C.yellow}/cost${C.reset}             Show token usage, cost, and active context window`
      )
      console.log(
        `  ${C.yellow}/context${C.reset}          Show detailed context window usage and capacity bar`
      )
      console.log(
        `  ${C.yellow}/clear${C.reset}            Clear the conversation history for this session`
      )
      console.log(
        `  ${C.yellow}/compact${C.reset}          Compact earlier context using LLM summary (or --force)`
      )
      console.log(
        `  ${C.yellow}/skills${C.reset}           List loaded workspace and global skills`
      )
      console.log(`  ${C.yellow}/diff${C.reset}             Show current git diff in the workspace`)
      console.log(`  ${C.yellow}/auto${C.reset}             Toggle auto-approval of tool actions`)
      console.log(`  ${C.yellow}/sessions${C.reset}         List recent saved sessions`)
      console.log(`  ${C.yellow}/exit${C.reset} or ${C.yellow}/quit${C.reset}     Exit the CLI\n`)
      console.log(`${C.dim}Tip: End a line with \\ to write multi-line prompts.${C.reset}\n`)
    }
  },

  mode: {
    desc: 'Switch between agent (read-write) and plan (read-only) mode',
    run: (args, ctx) => {
      const target = args[0]?.toLowerCase().trim() as 'agent' | 'plan' | undefined
      if (!target) {
        console.log(`\n  Current mode: ${C.bold}${C.green}${ctx.session.mode || 'agent'}${C.reset}`)
        console.log(`  Usage: ${C.cyan}/mode <agent | plan>${C.reset}\n`)
        return
      }
      if (target !== 'agent' && target !== 'plan') {
        console.log(
          `\n  ${C.red}${SYM.cross} Invalid mode. Use "/mode agent" or "/mode plan".${C.reset}\n`
        )
        return
      }
      ctx.session.mode = target
      if (ctx.setMode) ctx.setMode(target)
      const desc =
        target === 'plan' ? 'PLAN (read-only, planning focus)' : 'AGENT (full read-write)'
      console.log(
        `\n  ${C.green}${SYM.check}${C.reset} Switched mode to: ${C.bold}${C.cyan}${desc}${C.reset}\n`
      )
    }
  },

  plan: {
    desc: 'Quick toggle to plan mode',
    run: (_args, ctx) => {
      const next = ctx.session.mode === 'plan' ? 'agent' : 'plan'
      ctx.session.mode = next
      if (ctx.setMode) ctx.setMode(next)
      const desc = next === 'plan' ? 'PLAN (read-only, planning focus)' : 'AGENT (full read-write)'
      console.log(
        `\n  ${C.green}${SYM.check}${C.reset} Mode set to: ${C.bold}${C.cyan}${desc}${C.reset}\n`
      )
    }
  },

  tasks: {
    desc: 'View active task checklist',
    run: (_args, ctx) => {
      printTasksList(ctx.session.tasks || [])
    }
  },

  mcp: {
    desc: 'List connected MCP servers and their exposed tools',
    run: () => {
      const summaries = mcpServerSummaries()
      if (summaries.length === 0) {
        console.log(`\n  ${C.dim}No MCP servers currently connected.${C.reset}`)
        console.log(`  Add servers to ${C.cyan}.roxy/mcp.json${C.reset} or via agent tools.\n`)
        return
      }
      console.log(`\n${C.bold}${C.cyan}Connected MCP Servers (${summaries.length}):${C.reset}`)
      for (const s of summaries) {
        const statusColor = s.status === 'connected' ? C.green : C.red
        console.log(`  ${statusColor}●${C.reset} ${C.bold}${s.id}${C.reset} [${s.status}]:`)
        if (s.tools.length > 0) {
          console.log(`    Tools: ${s.tools.join(', ')}`)
        } else {
          console.log(`    Tools: ${C.dim}(none exposed)${C.reset}`)
        }
        if (s.error) {
          console.log(`    ${C.red}Error: ${s.error}${C.reset}`)
        }
      }
      console.log()
    }
  },

  tools: {
    desc: 'List all active tools available to the model',
    run: (_args, ctx) => {
      const mode = ctx.session.mode || 'agent'
      const schemas = getCliToolSchemas(mode)
      console.log(
        `\n${C.bold}${C.cyan}Available Tools in [${mode}] mode (${schemas.length}):${C.reset}`
      )
      for (const s of schemas) {
        const isMcp = s.function.name.startsWith('mcp__')
        const tag = isMcp ? `${C.brightMagenta}[mcp]${C.reset}` : `${C.dim}[builtin]${C.reset}`
        const desc = s.function.description ? ` — ${s.function.description.split('\n')[0]}` : ''
        console.log(`  ${C.yellow}● ${s.function.name}${C.reset} ${tag}${C.dim}${desc}${C.reset}`)
      }
      console.log()
    }
  },

  model: {
    desc: 'View or switch the active LLM model',
    run: (args, ctx) => {
      const newModel = args[0]?.trim()
      if (!newModel) {
        console.log(
          `\n  Current model: ${C.bold}${C.green}${ctx.session.provider}/${ctx.session.model}${C.reset}`
        )
        console.log(`  Usage: ${C.dim}/model <model-id>${C.reset}\n`)
        return
      }
      ctx.setModel(newModel)
      ctx.session.model = newModel
      saveStoredConfig({ model: newModel })
      console.log(
        `\n  ${C.green}${SYM.check}${C.reset} Switched model to: ${C.bold}${C.cyan}${newModel}${C.reset}\n`
      )
    }
  },

  models: {
    desc: 'List available models from the active provider',
    run: async (_args, ctx) => {
      try {
        const { baseUrl, apiKey } = await ensureOAuthSidecarRunning()
        const models = await getSidecarModels(baseUrl, apiKey)
        if (models.length === 0) {
          console.log(`\n  No models returned from provider.\n`)
          return
        }
        console.log(`\n${C.bold}${C.cyan}Available Models (${models.length}):${C.reset}`)
        for (const m of models.slice(0, 30)) {
          const isCurrent = m === ctx.session.model ? ` ${C.green}(current)${C.reset}` : ''
          console.log(`  ${C.yellow}●${C.reset} ${m}${isCurrent}`)
        }
        if (models.length > 30) {
          console.log(`  ${C.dim}... and ${models.length - 30} more models${C.reset}`)
        }
        console.log(`\n  ${C.dim}Switch model with: /model <model-id>${C.reset}\n`)
      } catch (e) {
        console.log(`\n  ${C.red}Failed to fetch models: ${(e as Error).message}${C.reset}\n`)
      }
    }
  },

  oauth: {
    desc: 'List connected OAuth subscriptions',
    run: () => {
      const accounts = listOAuthAccounts()
      if (accounts.length === 0) {
        console.log(`\n  ${C.yellow}No OAuth subscriptions found.${C.reset}`)
        console.log(
          `  Log in with: ${C.cyan}/login antigravity${C.reset} or ${C.cyan}/login claude${C.reset} or ${C.cyan}/login codex${C.reset}\n`
        )
        return
      }
      console.log(
        `\n${C.bold}${C.cyan}Connected OAuth Subscriptions (${accounts.length}):${C.reset}`
      )
      for (const a of accounts) {
        console.log(
          `  ${C.green}●${C.reset} ${C.bold}${a.label}${C.reset}: ${C.cyan}${a.email}${C.reset}`
        )
      }
      console.log(`\n  ${C.dim}Switch provider with: /provider <name>${C.reset}\n`)
    }
  },

  login: {
    desc: 'Log in to an OAuth subscription provider',
    run: async (args) => {
      const target = (args[0] || '').toLowerCase()
      if (target !== 'antigravity' && target !== 'claude' && target !== 'codex') {
        console.log(`\n  Usage: ${C.cyan}/login <antigravity | claude | codex>${C.reset}`)
        console.log(`  - ${C.bold}antigravity${C.reset}: Google / Gemini subscription`)
        console.log(`  - ${C.bold}claude${C.reset}: Anthropic Claude Pro/Team subscription`)
        console.log(`  - ${C.bold}codex${C.reset}: OpenAI ChatGPT subscription\n`)
        return
      }
      console.log(`\n  Starting ${target} OAuth sign-in flow...`)
      const res = await runSidecarOAuthLogin(target)
      if (res.ok) {
        console.log(
          `\n  ${C.green}${SYM.check} Successfully signed in${res.email ? ` as ${res.email}` : ''}!${C.reset}\n`
        )
      } else {
        console.log(`\n  ${C.red}${SYM.cross} Login failed: ${res.error}${C.reset}\n`)
      }
    }
  },

  provider: {
    desc: 'View or switch the active provider',
    run: (args, ctx) => {
      const prov = args[0]?.trim() as CliProvider | undefined
      if (!prov) {
        console.log(`\n  Current provider: ${C.bold}${C.green}${ctx.session.provider}${C.reset}`)
        console.log(`  OAuth providers: antigravity, claude-subscription, codex-subscription`)
        console.log(
          `  API key providers: anthropic, openai, gemini, openrouter, groq, deepseek, ollama`
        )
        console.log(`  Usage: ${C.dim}/provider <name>${C.reset}\n`)
        return
      }
      const allowed: CliProvider[] = [
        'oauth',
        'antigravity',
        'claude-subscription',
        'gemini-subscription',
        'codex-subscription',
        'anthropic',
        'openai',
        'gemini',
        'openrouter',
        'groq',
        'deepseek',
        'ollama'
      ]
      if (!allowed.includes(prov)) {
        console.log(
          `\n  ${C.red}${SYM.cross} Unknown provider "${prov}". Allowed: ${allowed.join(', ')}${C.reset}\n`
        )
        return
      }
      ctx.setProvider(prov)
      ctx.session.provider = prov
      const defaultModel = DEFAULT_MODELS[prov] || ctx.session.model
      ctx.setModel(defaultModel)
      ctx.session.model = defaultModel
      saveStoredConfig({ provider: prov, model: defaultModel })
      console.log(
        `\n  ${C.green}${SYM.check}${C.reset} Switched provider to: ${C.bold}${C.cyan}${prov}${C.reset} (default model: ${defaultModel})\n`
      )
    }
  },

  cost: {
    desc: 'Show token usage, cost, and active context window',
    run: (_args, ctx) => {
      const u = ctx.session.totalUsage
      const costStr = u.cost ? `${u.cost.toFixed(4)}` : '$0.00'
      const contextLimit =
        ctx.session.contextLimit || getModelContextLimit(ctx.session.provider, ctx.session.model)
      const activeTokens = estimateSessionTokens(ctx.session.messages)
      const pct = Math.min(100, Math.round((activeTokens / contextLimit) * 100))
      const pctColor = pct > 80 ? C.red : pct > 60 ? C.yellow : C.green

      console.log(`\n${C.bold}${C.cyan}Session Token Usage & Context:${C.reset}`)
      console.log(`  Prompt tokens:     ${C.bold}${u.promptTokens.toLocaleString()}${C.reset}`)
      console.log(`  Completion tokens: ${C.bold}${u.completionTokens.toLocaleString()}${C.reset}`)
      console.log(`  Total tokens:      ${C.bold}${u.totalTokens.toLocaleString()}${C.reset}`)
      console.log(`  Estimated cost:    ${C.bold}${C.green}${costStr}${C.reset}`)
      console.log(
        `  Active context:    ${pctColor}${activeTokens.toLocaleString()}${C.reset} / ${contextLimit.toLocaleString()} tokens (${pctColor}${pct}%${C.reset})`
      )
      console.log(`  Messages:          ${C.bold}${ctx.session.messages.length}${C.reset}\n`)
    }
  },

  context: {
    desc: 'Show active context window usage and capacity',
    run: (_args, ctx) => {
      const contextLimit =
        ctx.session.contextLimit || getModelContextLimit(ctx.session.provider, ctx.session.model)
      const activeTokens = estimateSessionTokens(ctx.session.messages)
      const pct = Math.min(100, Math.round((activeTokens / contextLimit) * 100))
      const pctColor = pct > 80 ? C.red : pct > 60 ? C.yellow : C.green
      const barLen = 20
      const filled = Math.min(barLen, Math.round((activeTokens / contextLimit) * barLen))
      const bar = `${pctColor}${'█'.repeat(filled)}${C.dim}${'░'.repeat(barLen - filled)}${C.reset}`

      console.log(`\n${C.bold}${C.cyan}Active Context Window:${C.reset}`)
      console.log(`  Model:     ${C.bold}${ctx.session.provider}/${ctx.session.model}${C.reset}`)
      console.log(`  Capacity:  [${bar}] ${pctColor}${pct}%${C.reset}`)
      console.log(
        `  Usage:     ${pctColor}${activeTokens.toLocaleString()}${C.reset} / ${contextLimit.toLocaleString()} tokens`
      )
      console.log(
        `  Headroom:  ${(contextLimit - activeTokens > 0 ? contextLimit - activeTokens : 0).toLocaleString()} tokens remaining`
      )
      console.log(`  Messages:  ${ctx.session.messages.length} messages in memory`)
      if (pct > 75) {
        console.log(
          `\n  ${C.yellow}⚡ Context is above 75% of capacity. Use /compact to summarize earlier turns.${C.reset}`
        )
      }
      console.log()
    }
  },

  clear: {
    desc: 'Clear conversation history and refresh screen',
    run: (_args, ctx) => {
      ctx.session.messages = []
      try {
        console.clear()
      } catch {
        // Ignore in environments where console.clear is unsupported
      }
      printBanner({
        version: CLI_VERSION,
        cwd: ctx.cwd,
        provider: ctx.session.provider,
        model: ctx.session.model,
        mode: ctx.session.mode,
        autoApprove: ctx.autoApprove,
        padToBottom: true
      })
    }
  },

  compact: {
    desc: 'Compact earlier messages to reduce context usage',
    run: async (args, ctx) => {
      const force = args.includes('--force') || args.includes('-f')
      const beforeCount = ctx.session.messages.length
      const contextLimit =
        ctx.session.contextLimit || getModelContextLimit(ctx.session.provider, ctx.session.model)
      const beforeTokens = estimateSessionTokens(ctx.session.messages)

      if (beforeCount <= 5 && !force) {
        console.log(
          `\n  ${C.dim}Conversation is short (${beforeCount} messages, ~${beforeTokens.toLocaleString()} tokens). Compaction not needed yet.${C.reset}`
        )
        console.log(`  Use ${C.cyan}/compact --force${C.reset} to compact anyway.\n`)
        return
      }

      console.log(
        `\n  ${C.yellow}Compacting conversation with ${C.bold}${ctx.session.model}${C.reset}${C.yellow}...${C.reset}`
      )
      const res = await compactSessionConversation({
        session: ctx.session,
        provider: ctx.session.provider,
        model: ctx.session.model,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        force
      })

      if (!res.compacted) {
        console.log(
          `  ${C.yellow}Compaction skipped: ${res.error || 'not enough history'}${C.reset}\n`
        )
        return
      }

      const savedTokens = Math.max(0, res.beforeTokens - res.afterTokens)
      const savedPct = res.beforeTokens > 0 ? Math.round((savedTokens / res.beforeTokens) * 100) : 0

      console.log(
        `\n  ${C.green}${SYM.check} ${C.bold}Compacted conversation successfully!${C.reset}`
      )
      console.log(
        `  • Messages: ${C.yellow}${res.beforeCount}${C.reset} → ${C.green}${res.afterCount}${C.reset}`
      )
      console.log(
        `  • Tokens:   ${C.yellow}~${res.beforeTokens.toLocaleString()}${C.reset} → ${C.green}~${res.afterTokens.toLocaleString()}${C.reset} (${C.green}reduced by ${savedPct}%${C.reset})`
      )
      console.log(
        `  • Method:   ${res.method === 'llm' ? `${C.cyan}LLM Structured Summary${C.reset}` : `${C.dim}Deterministic Trim${C.reset}`}`
      )
      console.log(
        `  • Budget:   ${res.afterTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens in context\n`
      )
      await saveSession(ctx.session)
    }
  },

  skills: {
    desc: 'List available skills',
    run: async (_args, ctx) => {
      try {
        const skills = await listSkills(ctx.cwd)
        if (skills.length === 0) {
          console.log(`\n  No skills found in workspace or global directory.\n`)
          return
        }
        console.log(`\n${C.bold}${C.cyan}Discovered Skills (${skills.length}):${C.reset}`)
        for (const s of skills) {
          console.log(
            `  ${C.yellow}● ${s.name}${C.reset} ${C.dim}(${s.source})${C.reset}: ${s.description || '(no description)'}`
          )
        }
        console.log()
      } catch (e) {
        console.log(`\n  ${C.red}Error scanning skills: ${(e as Error).message}${C.reset}\n`)
      }
    }
  },

  diff: {
    desc: 'Show git diff in the workspace',
    run: (_args, ctx) => {
      try {
        const diff = execSync('git diff', { cwd: ctx.cwd, encoding: 'utf8' }).trim()
        if (!diff) {
          console.log(`\n  ${C.dim}No uncommitted changes in git.${C.reset}\n`)
          return
        }
        console.log(`\n${C.bold}${C.cyan}Git Diff:${C.reset}\n`)
        for (const line of diff.split('\n')) {
          if (line.startsWith('+')) {
            console.log(`${C.green}${line}${C.reset}`)
          } else if (line.startsWith('-')) {
            console.log(`${C.red}${line}${C.reset}`)
          } else if (line.startsWith('@@')) {
            console.log(`${C.cyan}${line}${C.reset}`)
          } else {
            console.log(`${C.dim}${line}${C.reset}`)
          }
        }
        console.log()
      } catch (e) {
        console.log(`\n  ${C.red}Git diff error: ${(e as Error).message}${C.reset}\n`)
      }
    }
  },

  auto: {
    desc: 'Toggle auto-approval mode',
    run: (_args, ctx) => {
      const next = !ctx.autoApprove
      ctx.setAutoApprove(next)
      const status = next
        ? `${C.green}ENABLED (all tools execute automatically)${C.reset}`
        : `${C.yellow}DISABLED (prompts before edits/bash)${C.reset}`
      console.log(`\n  Auto-approval is now: ${status}\n`)
    }
  },

  sessions: {
    desc: 'List recent sessions',
    run: () => {
      const list = listRecentSessions(8)
      if (list.length === 0) {
        console.log(`\n  No recent sessions found.\n`)
        return
      }
      console.log(`\n${C.bold}${C.cyan}Recent Sessions:${C.reset}`)
      for (const s of list) {
        const d = new Date(s.updatedAt).toLocaleTimeString()
        console.log(
          `  ${C.yellow}${s.id}${C.reset} ${C.dim}[${d}]${C.reset} ${s.model} in ${C.dim}${s.cwd}${C.reset}`
        )
      }
      console.log(`  ${C.dim}Resume any with: roxy --resume <id>${C.reset}\n`)
    }
  },

  exit: {
    desc: 'Exit the CLI',
    run: (_args, ctx) => {
      ctx.exit()
    }
  },

  quit: {
    desc: 'Exit the CLI',
    run: (_args, ctx) => {
      ctx.exit()
    }
  }
}

/** Check if input line is a slash command and execute it. Returns true if handled. */
export async function handleSlashCommand(line: string, ctx: CommandContext): Promise<boolean> {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return false

  const parts = trimmed.slice(1).split(/\s+/)
  const cmdName = parts[0]?.toLowerCase()
  const args = parts.slice(1)

  const cmd = COMMANDS[cmdName]
  if (!cmd) {
    console.log(
      `\n  ${C.red}${SYM.cross} Unknown command "/${cmdName}". Type ${C.yellow}/help${C.red} for a list of commands.${C.reset}\n`
    )
    return true
  }

  await cmd.run(args, ctx)
  return true
}
