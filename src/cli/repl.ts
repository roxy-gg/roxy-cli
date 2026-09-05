/**
 * CLI Interactive REPL (Read-Eval-Print-Loop).
 * Features rich terminal prompts, live streaming, interactive approvals, and slash commands.
 */
import readline from 'node:readline'
import {
  C,
  SYM,
  Spinner,
  printBanner,
  printUserMessage,
  printAssistantHeader,
  printTurnFooter,
  printToolStart,
  printToolEnd,
  StreamingMarkdownRenderer
} from './ui'
import type { CliProvider, CliSessionData, ToolApprovalDecision } from './types'
import { runCliAgentTurn } from './agent'
import { saveSession, updateSessionUsage } from './session'
import { handleSlashCommand, type CommandContext } from './commands'
import { killAllCliBackground, shutdownAllLsp, shutdownAllMcp } from './tools'
import {
  isSessionNearLimit,
  compactSessionConversation,
  getModelContextLimit,
  estimateSessionTokens
} from './compaction'

export interface StartReplOptions {
  version: string
  cwd: string
  provider: CliProvider
  model: string
  apiKey: string
  baseUrl?: string
  session: CliSessionData
  autoApprove?: boolean
  verbose?: boolean
  account?: string
}

export async function startRepl(opts: StartReplOptions): Promise<void> {
  let { provider, model, apiKey, baseUrl, autoApprove = false } = opts
  const { version, cwd, session, verbose = false, account } = opts

  if (process.stdout.isTTY) {
    try {
      console.clear()
    } catch {
      // Ignore
    }
  }

  printBanner({
    version,
    cwd,
    provider,
    model,
    account,
    mode: session.mode,
    autoApprove,
    padToBottom: true
  })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  })

  let isTurnRunning = false
  let currentAbortController: AbortController | null = null
  let multilineBuffer = ''

  const getPrompt = (): string => {
    const modeIndicator = session.mode === 'plan' ? `${C.yellow}[plan]${C.reset} ` : ''
    const autoIndicator = autoApprove ? `${C.green}[auto]${C.reset} ` : ''
    return multilineBuffer
      ? `${C.dim}  ... ${C.reset}`
      : `${modeIndicator}${autoIndicator}${C.bold}${C.blue}roxy${C.reset} ${C.brightBlue}${SYM.pointer}${C.reset} `
  }

  const promptUser = (): void => {
    rl.setPrompt(getPrompt())
    rl.prompt()
  }

  // Tool approval helper for interactive mode
  const askApproval = async (
    toolName: string,
    _input: Record<string, unknown>,
    preview?: string
  ): Promise<ToolApprovalDecision> => {
    if (preview) {
      console.log(`\n${preview}\n`)
    }

    return new Promise<ToolApprovalDecision>((resolve) => {
      rl.question(
        `  ${C.yellow}Roxy requests approval for ${C.bold}${toolName}${C.reset}${C.yellow}. Allow? [y]es / [n]o / [a]lways / [s]top:${C.reset} `,
        (ans) => {
          const a = (ans || 'y').trim().toLowerCase()
          if (a === 'y' || a === 'yes' || a === '') return resolve('yes')
          if (a === 'a' || a === 'always') return resolve('always')
          if (a === 's' || a === 'stop') return resolve('stop')
          return resolve('no')
        }
      )
    })
  }

  const executeTurn = async (userPrompt: string): Promise<void> => {
    isTurnRunning = true
    currentAbortController = new AbortController()

    // Add user message to conversation history
    session.messages.push({ role: 'user', content: userPrompt })

    printUserMessage(userPrompt)

    // Check if context is approaching model limit and auto-compact if needed
    const contextLimit = session.contextLimit || getModelContextLimit(provider, model)
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
          provider,
          model,
          apiKey,
          baseUrl,
          signal: currentAbortController.signal
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

    try {
      const result = await runCliAgentTurn({
        sessionId: session.id,
        cwd,
        provider,
        model,
        apiKey,
        baseUrl,
        messages: session.messages,
        autoApprove,
        verbose,
        mode: session.mode || 'agent',
        session,
        signal: currentAbortController.signal,

        onTextChunk: (chunk: string) => {
          if (!hasReceivedText) {
            spinner.stop()
            hasReceivedText = true
            printAssistantHeader()
          }
          mdRenderer.write(chunk)
        },

        onReasoningChunk: (_chunk: string) => {
          spinner.update('Reasoning...')
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
        },

        askApproval: async (toolName, input, preview) => {
          spinner.stop()
          const decision = await askApproval(toolName, input, preview)
          spinner.start()
          return decision
        }
      })

      spinner.stop()

      if (hasReceivedText) {
        mdRenderer.flush()
      }

      if (!result.ok && result.error) {
        console.log(`\n  ${C.red}${SYM.cross} ${result.error}${C.reset}\n`)
      }

      printTurnFooter({
        durationMs: Date.now() - turnStartTime,
        totalTokens: result.usage.totalTokens,
        cost: result.usage.cost,
        model: model
      })

      // Update session state
      session.messages = result.messages
      updateSessionUsage(session, result.usage)
      await saveSession(session)
    } catch (e) {
      spinner.stop()
      console.log(`\n  ${C.red}${SYM.cross} Error: ${(e as Error).message}${C.reset}\n`)
    } finally {
      isTurnRunning = false
      currentAbortController = null
      promptUser()
    }
  }

  const cleanShutdown = (): void => {
    killAllCliBackground()
    shutdownAllLsp()
    shutdownAllMcp()
  }

  // Context passed to slash commands
  const cmdCtx: CommandContext = {
    session,
    cwd,
    autoApprove,
    setAutoApprove: (val) => {
      autoApprove = val
    },
    setProvider: (p) => {
      provider = p
    },
    setModel: (m) => {
      model = m
    },
    setMode: (m) => {
      session.mode = m
    },
    exit: () => {
      cleanShutdown()
      rl.close()
      process.exit(0)
    },
    apiKey,
    baseUrl
  }

  rl.on('line', async (line) => {
    if (isTurnRunning) return

    // Handle multiline typing (ending with \)
    if (line.endsWith('\\')) {
      multilineBuffer += line.slice(0, -1) + '\n'
      promptUser()
      return
    }

    const fullInput = (multilineBuffer + line).trim()
    multilineBuffer = ''

    if (!fullInput) {
      promptUser()
      return
    }

    // Check for slash commands
    if (fullInput.startsWith('/')) {
      const handled = await handleSlashCommand(fullInput, cmdCtx)
      if (handled) {
        promptUser()
        return
      }
    }

    // Execute agent prompt
    await executeTurn(fullInput)
  })

  // Graceful SIGINT (Ctrl+C) handling
  let lastSigint = 0
  rl.on('SIGINT', () => {
    if (isTurnRunning && currentAbortController) {
      console.log(`\n  ${C.yellow}Stopping turn...${C.reset}`)
      currentAbortController.abort()
      return
    }

    const now = Date.now()
    if (now - lastSigint < 2000) {
      cleanShutdown()
      console.log(`\n${C.dim}Goodbye!${C.reset}\n`)
      process.exit(0)
    } else {
      lastSigint = now
      console.log(`\n${C.dim}Press Ctrl+C again or type /exit to quit.${C.reset}`)
      promptUser()
    }
  })

  promptUser()
}
