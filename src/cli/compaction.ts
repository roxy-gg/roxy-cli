/**
 * CLI Intelligent Context Management & Compaction.
 * Provides:
 *  1. Model context limit detection & token budgeting.
 *  2. Tool output pruning to shed thousands of bytes before dropping turns.
 *  3. LLM-driven structured context summarization with anchored previous summaries.
 *  4. Graceful deterministic fallback when offline or during API errors.
 */
import { messageTokens, isOverflow, pruneToolMessages, COMPACTION_BUFFER } from '../shared/context'
import type { CliMessage, CliProvider, CliSessionData } from './types'
import { streamChatTurn } from './providers'
import { compactMessages } from './session'

/**
 * Context limit thresholds for common AI models and providers.
 * Returns the estimated token capacity of the active model window.
 */
export function getModelContextLimit(provider?: string, model?: string): number {
  const p = (provider || '').toLowerCase()
  const m = (model || '').toLowerCase()

  // Gemini models: 1M tokens
  if (p.includes('gemini') || p.includes('antigravity') || m.includes('gemini')) {
    return 1_000_000
  }

  // Claude models: standard 200k tokens (or 1M for extended beta models)
  if (p.includes('claude') || p.includes('anthropic') || m.includes('claude')) {
    if (m.includes('1m')) return 1_000_000
    return 200_000
  }

  // OpenAI / Codex models: 128k tokens
  if (
    p.includes('openai') ||
    p.includes('codex') ||
    m.includes('gpt-4') ||
    m.includes('o1') ||
    m.includes('o3') ||
    m.includes('o4')
  ) {
    return 128_000
  }

  // DeepSeek: 64k tokens
  if (p.includes('deepseek') || m.includes('deepseek')) {
    return 64_000
  }

  // Groq models: 128k for Llama-3.3 / Llama-3.1, else 32k
  if (p.includes('groq')) {
    if (m.includes('llama-3.3') || m.includes('llama-3.1')) return 128_000
    return 32_000
  }

  // Ollama local models: 32k
  if (p.includes('ollama')) {
    return 32_000
  }

  // Default safe context limit
  return 128_000
}

/** Estimate total tokens currently in the conversation history. */
export function estimateSessionTokens(messages: CliMessage[]): number {
  return messages.reduce((total, msg) => total + messageTokens(msg), 0)
}

/** Check if session tokens are approaching or exceed the safe compaction threshold. */
export function isSessionNearLimit(
  messages: CliMessage[],
  contextLimit: number,
  outputReserve: number = 4_096,
  buffer: number = COMPACTION_BUFFER
): boolean {
  const used = estimateSessionTokens(messages)
  return isOverflow(used, contextLimit, outputReserve, buffer)
}

/**
 * Prune older bulky tool outputs to a head/tail preview while keeping recent turns intact.
 * Rapidly sheds thousands of tokens from earlier file reads, git diffs, and bash logs.
 */
export function pruneToolOutputs(
  messages: CliMessage[],
  keepRecentTokens: number = 8_000
): CliMessage[] {
  return pruneToolMessages(messages, {
    keepRecentTokens,
    previewLines: 20,
    previewChars: 2_000
  })
}

/** System prompt for the LLM summarizer. */
export const COMPACT_SYSTEM =
  'You are an anchored context-summarization assistant for coding sessions. Summarize only the conversation history you are given, preserving the essential context needed to continue. Output only the summary.'

/** Instructions and structure for the compact output. */
export const COMPACT_STRUCTURE = [
  'Summarize the conversation below so the assistant can continue with no loss of essential context.',
  'Preserve: the user’s goals and constraints, decisions made, files created or edited (with exact paths), key code snippets, commands run and their results or errors, the current state, and any open tasks or questions.',
  'Drop greetings and redundant detail. Use terse markdown bullet points grouped by topic. Output ONLY the summary.'
].join(' ')

export interface CompactSessionOptions {
  session: CliSessionData
  provider?: CliProvider
  model?: string
  apiKey?: string
  baseUrl?: string
  signal?: AbortSignal
  force?: boolean
  keepRecentTurns?: number
}

export interface CompactSessionResult {
  compacted: boolean
  beforeCount: number
  afterCount: number
  beforeTokens: number
  afterTokens: number
  method: 'llm' | 'deterministic' | 'none'
  summary?: string
  error?: string
}

/** Flatten a CLI message for summarization prompt. */
/**
 * Move a proposed cut point forward until it lands on a message that can
 * legally start a conversation.
 *
 * Slicing purely by count can orphan a `tool` message from the `assistant`
 * turn that requested it. Both Anthropic and OpenAI reject that outright
 * (`unexpected tool_use_id found in tool_result blocks`, HTTP 400), so a
 * long-running session would break the moment it auto-compacted. Tool results
 * at the boundary are pushed into the summarized half, where they are prose
 * rather than protocol.
 */
function safeCutIndex(messages: CliMessage[], desired: number): number {
  let i = Math.max(0, Math.min(desired, messages.length))
  while (i < messages.length && messages[i].role === 'tool') i++
  return i
}

function formatMessageForSummary(m: CliMessage): string {
  let content = m.content || ''
  if (m.toolCalls && m.toolCalls.length > 0) {
    const callNames = m.toolCalls.map((tc) => `${tc.name}(${tc.arguments || ''})`).join(', ')
    content = `${content}\n[Tool Calls: ${callNames}]`.trim()
  }
  return `${m.role.toUpperCase()}: ${content}`
}

/**
 * Execute intelligent LLM-driven compaction on a CLI session.
 * Falls back to deterministic compaction if the LLM call is unavailable or fails.
 */
export async function compactSessionConversation(
  opts: CompactSessionOptions
): Promise<CompactSessionResult> {
  const { session, signal, keepRecentTurns = 4 } = opts
  const beforeCount = session.messages.length
  const beforeTokens = estimateSessionTokens(session.messages)

  // Need at least system + 1 turn to compact + keepRecentTurns
  if (beforeCount <= keepRecentTurns + 1) {
    return {
      compacted: false,
      beforeCount,
      afterCount: beforeCount,
      beforeTokens,
      afterTokens: beforeTokens,
      method: 'none',
      error: 'Conversation is too short to compact.'
    }
  }

  // 1. First line of defense: prune older bulky tool outputs
  let workingMessages = pruneToolOutputs(session.messages)

  const systemMessage = workingMessages.find((m) => m.role === 'system')
  const nonSystem = workingMessages.filter((m) => m.role !== 'system')

  const keepCount = Math.min(keepRecentTurns, nonSystem.length)
  const cutIndex = safeCutIndex(nonSystem, nonSystem.length - keepCount)
  const recentMessages = nonSystem.slice(cutIndex)
  const middleMessages = nonSystem.slice(0, cutIndex)

  if (middleMessages.length === 0) {
    session.messages = workingMessages
    const afterTokens = estimateSessionTokens(session.messages)
    return {
      compacted: false,
      beforeCount,
      afterCount: session.messages.length,
      beforeTokens,
      afterTokens,
      method: 'none',
      error: 'No earlier messages to summarize.'
    }
  }

  // Check for prior summary to anchor and merge
  let priorSummary = ''
  for (const m of middleMessages) {
    if (m.content.includes('[Previous Conversation Summary]')) {
      priorSummary = m.content.replace('[Previous Conversation Summary]', '').trim()
    }
  }

  const priorBlock = priorSummary
    ? `<previous-summary>\n${priorSummary}\n</previous-summary>\n\n`
    : ''

  const convoText = middleMessages.map(formatMessageForSummary).join('\n\n').slice(-120_000)

  const provider = opts.provider || session.provider
  const model = opts.model || session.model
  const apiKey = opts.apiKey || ''
  const baseUrl = opts.baseUrl

  let generatedSummary = ''
  let usedMethod: 'llm' | 'deterministic' = 'deterministic'

  // Attempt LLM summarization if credentials exist
  if (apiKey || provider === 'ollama' || baseUrl) {
    try {
      await streamChatTurn({
        provider,
        model,
        apiKey,
        baseUrl,
        signal,
        noTools: true,
        messages: [
          { role: 'system', content: COMPACT_SYSTEM },
          {
            role: 'user',
            content: `${COMPACT_STRUCTURE}\n\n${priorBlock}Conversation to compact:\n\n${convoText}`
          }
        ],
        onEvent: (ev) => {
          if (ev.type === 'text') {
            generatedSummary += ev.delta
          }
        }
      })

      if (generatedSummary.trim()) {
        usedMethod = 'llm'
      }
    } catch {
      // Fallback to deterministic compaction on API failure
      usedMethod = 'deterministic'
    }
  }

  if (usedMethod === 'llm' && generatedSummary.trim()) {
    const summaryText = generatedSummary.trim()
    session.messages = [
      ...(systemMessage ? [systemMessage] : []),
      {
        role: 'user',
        content: `[Previous Conversation Summary]\n\n${summaryText}`
      },
      {
        role: 'assistant',
        content:
          'Understood. I have absorbed the prior conversation summary, goals, technical decisions, and file paths. I will continue assisting from here.'
      },
      ...recentMessages
    ]
  } else {
    // Deterministic fallback
    session.messages = compactMessages(session.messages)
  }

  const afterCount = session.messages.length
  const afterTokens = estimateSessionTokens(session.messages)

  return {
    compacted: true,
    beforeCount,
    afterCount,
    beforeTokens,
    afterTokens,
    method: usedMethod,
    summary: generatedSummary.trim() || undefined
  }
}
