/**
 * Roxy CLI Entrypoint.
 * Parses CLI arguments, handles piped input, launches REPL or runs single-shot queries.
 */
import path from 'node:path'
import {
  C,
  SYM,
  Spinner,
  printUserMessage,
  printAssistantHeader,
  printTurnFooter,
  printToolStart,
  printToolEnd,
  StreamingMarkdownRenderer
} from './ui'
import type { CliConfig, CliProvider } from './types'
import { CLI_VERSION } from './version'
import { resolveConfig, isOAuthProvider } from './config'
import {
  createNewSession,
  loadSession,
  saveSession,
  updateSessionUsage,
  listRecentSessions
} from './session'
import { runCliAgentTurn } from './agent'
import { startRepl } from './repl'
import { killAllCliBackground, shutdownAllLsp, shutdownAllMcp } from './tools'
import {
  isSessionNearLimit,
  compactSessionConversation,
  getModelContextLimit,
  estimateSessionTokens
} from './compaction'
import {
  ensureOAuthSidecarRunning,
  listOAuthAccounts,
  runSidecarOAuthLogin,
  stopSidecar
} from './oauth'

const VERSION = CLI_VERSION

interface ParsedArgs {
  prompt?: string
  model?: string
  provider?: CliProvider
  cwd?: string
  resume?: string
  autoApprove?: boolean
  verbose?: boolean
  help?: boolean
  version?: boolean
  login?: 'antigravity' | 'claude' | 'codex'
  listAccounts?: boolean
  plan?: boolean
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {}
  const positionals: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === 'login') {
      const next = (args[i + 1] || 'antigravity').toLowerCase()
      if (next === 'antigravity' || next === 'claude' || next === 'codex') {
        parsed.login = next
        i++
      } else {
        parsed.login = 'antigravity'
      }
    } else if (arg === 'oauth' || arg === 'accounts') {
      parsed.listAccounts = true
    } else if (arg === '--oauth') {
      parsed.provider = 'oauth'
    } else if (arg === '--plan') {
      parsed.plan = true
    } else if (arg === '-h' || arg === '--help') {
      parsed.help = true
    } else if (arg === '-v' || arg === '--version') {
      parsed.version = true
    } else if (arg === '-y' || arg === '--yes') {
      parsed.autoApprove = true
    } else if (arg === '--verbose') {
      parsed.verbose = true
    } else if (arg === '-p' || arg === '--prompt') {
      parsed.prompt = args[++i]
    } else if (arg === '-m' || arg === '--model') {
      parsed.model = args[++i]
    } else if (arg === '--provider') {
      parsed.provider = args[++i] as CliProvider
    } else if (arg === '-c' || arg === '--cwd') {
      parsed.cwd = args[++i]
    } else if (arg === '-r' || arg === '--resume') {
      parsed.resume = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : 'latest'
    } else if (!arg.startsWith('-')) {
      positionals.push(arg)
    }
  }

  if (!parsed.prompt && positionals.length > 0) {
    parsed.prompt = positionals.join(' ')
  }

  return parsed
}

function printHelp(): void {
  console.log(`
${C.bold}${C.cyan}ROXY CLI${C.reset} — Terminal AI Coding Agent

${C.bold}USAGE:${C.reset}
  roxy [options] [prompt]
  roxy -p "your prompt here"
  roxy login <antigravity | claude | codex>
  roxy oauth
  cat file.ts | roxy "analyze this code"

${C.bold}OPTIONS:${C.reset}
  -p, --prompt <text>     Run a prompt in single-shot mode and exit
  -m, --model <name>      Choose AI model (e.g. gemini-3.8-flash-high, claude-3-7-sonnet, gpt-4o)
  --provider <name>       Choose AI provider:
                          OAuth: antigravity (Google/Gemini), claude-subscription, codex-subscription
                          Roxy: roxy (https://roxy.gg \u2014 every frontier model, one key)
                          API: anthropic, openai, gemini, openrouter, groq, deepseek, ollama, custom
  --oauth                 Force use of local OAuth subscription accounts
  --plan                  Run in Plan mode (read-only planning and investigation, no file changes)
  -y, --yes               Auto-approve mutating actions (file edits and bash commands)
  -c, --cwd <path>        Set workspace root directory (defaults to current directory)
  -r, --resume [id]       Resume a previous session (or latest session if no id is passed)
  --verbose               Show detailed debug logs
  -v, --version           Show version number
  -h, --help              Show this help message

${C.bold}COMMANDS:${C.reset}
  roxy login [provider]   Log in to an OAuth subscription (antigravity, claude, codex)
  roxy oauth              List active OAuth accounts

${C.bold}SLASH COMMANDS (Inside REPL):${C.reset}
  /help       Show commands
  /model      View or change model
  /models     List available models from provider
  /provider   Change AI provider
  /mode       Switch between 'agent' and 'plan' mode
  /tasks      Show session task checklist
  /mcp        List connected MCP servers and tools
  /tools      List active agent tools
  /oauth      Show active OAuth subscriptions
  /login      Log in via OAuth in browser
  /cost       Show token usage and cost
  /clear      Clear conversation history
  /skills     List available skills
  /diff       Show git diff
  /auto       Toggle auto-approval mode
  /exit       Quit the CLI
`)
}

/** Read data piped via stdin if available. */
async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise<string>((resolve) => {
    let data = ''

    const cleanup = (): void => {
      process.stdin.removeAllListeners('data')
      process.stdin.removeAllListeners('end')
      process.stdin.removeAllListeners('error')
      process.stdin.pause()
    }

    const timer = setTimeout(() => {
      // If no data arrived after 50ms, stdin wasn't piped
      cleanup()
      resolve('')
    }, 50)

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      clearTimeout(timer)
      data += chunk
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)
      cleanup()
      resolve(data)
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      cleanup()
      resolve('')
    })
  })
}

function cleanAllResources(): void {
  killAllCliBackground()
  shutdownAllLsp()
  shutdownAllMcp()
  stopSidecar()
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)

  if (args.version) {
    console.log(`roxy v${VERSION}`)
    return
  }

  if (args.help) {
    printHelp()
    return
  }

  // Handle "roxy oauth" or "roxy accounts"
  if (args.listAccounts) {
    const accounts = listOAuthAccounts()
    if (accounts.length === 0) {
      console.log(`\n  ${C.yellow}No OAuth subscriptions found.${C.reset}`)
      console.log(`  Log in with: roxy login <antigravity | claude | codex>\n`)
      return
    }
    console.log(`\n${C.bold}${C.cyan}Active OAuth Subscriptions (${accounts.length}):${C.reset}`)
    for (const a of accounts) {
      console.log(
        `  ${C.green}●${C.reset} ${C.bold}${a.label}${C.reset}: ${C.cyan}${a.email}${C.reset}`
      )
    }
    console.log()
    return
  }

  // Handle "roxy login <provider>"
  if (args.login) {
    console.log(`\n  Starting ${args.login} OAuth sign-in flow...`)
    const res = await runSidecarOAuthLogin(args.login)
    if (res.ok) {
      console.log(
        `\n  ${C.green}${SYM.check} Successfully signed in${res.email ? ` as ${res.email}` : ''}!${C.reset}\n`
      )
    } else {
      console.log(`\n  ${C.red}${SYM.cross} Login failed: ${res.error}${C.reset}\n`)
      process.exit(1)
    }
    return
  }

  const cwd = path.resolve(args.cwd || process.cwd())

  const overrides: Partial<CliConfig> = {}
  if (args.provider) overrides.provider = args.provider
  if (args.model) overrides.model = args.model
  if (args.autoApprove) overrides.autoApprove = true
  if (args.verbose) overrides.verbose = true
  if (args.plan) overrides.mode = 'plan'

  const config = resolveConfig(cwd, overrides)
  let activeOAuthAccount: string | undefined

  // If provider is OAuth-backed, connect to/spawn CLIProxyAPI sidecar
  if (isOAuthProvider(config.provider)) {
    try {
      const sidecar = await ensureOAuthSidecarRunning()
      config.baseUrl = sidecar.baseUrl
      config.apiKey = sidecar.apiKey

      const accounts = sidecar.accounts
      if (accounts.length > 0) {
        // Pick matching account
        const matched =
          accounts.find(
            (a) => a.upstream === config.provider || a.providerId === config.provider
          ) || accounts[0]
        activeOAuthAccount = `${matched.label} (${matched.email})`
      }
    } catch (e) {
      console.error(
        `\n${C.red}${SYM.cross} Failed to connect to OAuth proxy sidecar: ${(e as Error).message}${C.reset}\n`
      )
      process.exit(1)
    }
  }

  // Validate API key if not local ollama or OAuth
  if (!isOAuthProvider(config.provider) && config.provider !== 'ollama' && !config.apiKey) {
    console.error(
      `\n${C.red}${SYM.cross} Error: No API key found for provider "${config.provider}".${C.reset}`
    )
    console.error(`${C.dim}Get started in any of these ways:${C.reset}`)
    console.error(``)
    console.error(`  ${C.bold}1.${C.reset} Roxy inference \u2014 every frontier model behind one key, pay as you go`)
    console.error(`     ${C.dim}Create a key at https://roxy.gg/dashboard, then:${C.reset}`)
    console.error(`     export ROXY_API_KEY=rx-...`)
    console.error(``)
    console.error(`  ${C.bold}2.${C.reset} A subscription you already pay for`)
    console.error(`     roxy login`)
    console.error(``)
    console.error(`  ${C.bold}3.${C.reset} Run locally, free`)
    console.error(`     roxy --provider ollama`)
    console.error(``)
    console.error(`${C.dim}Other providers: set OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY,${C.reset}`)
    console.error(`${C.dim}GROQ_API_KEY, DEEPSEEK_API_KEY, or ANTHROPIC_API_KEY.${C.reset}\n`)
    process.exit(1)
  }

  // Handle session resuming or creation
  let session = createNewSession(cwd, config.provider, config.model)
  if (args.plan) {
    session.mode = 'plan'
  }

  if (args.resume) {
    let resumeId = args.resume
    if (resumeId === 'latest') {
      const recents = listRecentSessions(1)
      if (recents.length > 0) {
        resumeId = recents[0].id
      }
    }
    const loaded = loadSession(resumeId)
    if (loaded) {
      session = loaded
      if (args.plan) session.mode = 'plan'
      console.log(
        `\n  ${C.green}${SYM.check}${C.reset} Resumed session ${C.bold}${session.id}${C.reset} (${session.messages.length} messages)`
      )
    } else {
      console.log(
        `\n  ${C.yellow}Session "${resumeId}" not found. Created new session ${session.id}.${C.reset}`
      )
    }
  }

  // Check for piped stdin
  const pipedInput = await readPipedStdin()
  let promptText = args.prompt || ''
  if (pipedInput) {
    promptText = promptText
      ? `${promptText}\n\nInput data:\n\`\`\`\n${pipedInput}\n\`\`\``
      : pipedInput
  }

  // Single-shot mode: run prompt and exit
  if (promptText) {
    session.messages.push({ role: 'user', content: promptText })

    printUserMessage(promptText)

    // Check if context is approaching model limit and auto-compact if needed
    const contextLimit = session.contextLimit || getModelContextLimit(config.provider, config.model)
    if (isSessionNearLimit(session.messages, contextLimit)) {
      const currentTokens = estimateSessionTokens(session.messages)
      console.log(
        `\n  ${C.yellow}⚡ Context approaching budget (${currentTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens). Auto-compacting...${C.reset}`
      )
      const compactSpinner = new Spinner('Auto-compacting conversation history...')
      compactSpinner.start()
      try {
        const compRes = await compactSessionConversation({
          session,
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl
        })
        compactSpinner.stop()
        if (compRes.compacted) {
          console.log(
            `  ${C.green}${SYM.check}${C.reset} Auto-compacted context: ${C.yellow}${compRes.beforeTokens.toLocaleString()}${C.reset} → ${C.green}${compRes.afterTokens.toLocaleString()}${C.reset} tokens (${compRes.beforeCount} → ${compRes.afterCount} messages).\n`
          )
          await saveSession(session)
        }
      } catch (e) {
        compactSpinner.stop()
        console.warn(`  ${C.yellow}⚠ Auto-compaction notice: ${(e as Error).message}${C.reset}\n`)
      }
    }

    const turnStartTime = Date.now()

    const spinner = new Spinner('Thinking...')
    spinner.start()
    let hasReceivedText = false
    const mdRenderer = new StreamingMarkdownRenderer()

    const abortCtrl = new AbortController()
    process.on('SIGINT', () => {
      console.log(`\n${C.yellow}Stopping...${C.reset}`)
      abortCtrl.abort()
      cleanAllResources()
      process.exit(130)
    })

    try {
      const result = await runCliAgentTurn({
        sessionId: session.id,
        cwd,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        messages: session.messages,
        autoApprove: config.autoApprove,
        verbose: config.verbose,
        mode: session.mode || 'agent',
        session,
        signal: abortCtrl.signal,

        onTextChunk: (chunk: string) => {
          if (!hasReceivedText) {
            spinner.stop()
            hasReceivedText = true
            printAssistantHeader()
          }
          mdRenderer.write(chunk)
        },

        onToolStart: (
          toolName: string,
          id: string,
          _argsText: string,
          argsObj?: Record<string, unknown>
        ) => {
          spinner.stop()
          if (hasReceivedText) {
            mdRenderer.flush()
            hasReceivedText = false
          }
          printToolStart(toolName, id, argsObj)
          spinner.update(`Executing ${toolName}...`)
          spinner.start()
        },

        onToolEnd: (
          toolName: string,
          _id: string,
          ok: boolean,
          output: string,
          _diff?: any,
          argsObj?: Record<string, unknown>
        ) => {
          spinner.stop()
          printToolEnd(toolName, ok, output, argsObj)
          spinner.update('Thinking...')
          spinner.start()
        }
      })

      spinner.stop()
      if (hasReceivedText) {
        mdRenderer.flush()
      }

      if (!result.ok && result.error) {
        console.error(`\n${C.red}${SYM.cross} ${result.error}${C.reset}`)
        process.exit(1)
      }

      printTurnFooter({
        durationMs: Date.now() - turnStartTime,
        totalTokens: result.usage.totalTokens,
        cost: result.usage.cost,
        model: config.model
      })

      session.messages = result.messages
      updateSessionUsage(session, result.usage)
      await saveSession(session)
    } finally {
      cleanAllResources()
    }

    process.exit(0)
  }

  // Interactive REPL mode
  try {
    await startRepl({
      version: VERSION,
      cwd,
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      session,
      autoApprove: config.autoApprove,
      verbose: config.verbose,
      account: activeOAuthAccount
    })
  } finally {
    cleanAllResources()
  }
}

// Direct execution when invoked from node
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(`\nFatal error: ${err.message}`)
    process.exit(1)
  })
}
