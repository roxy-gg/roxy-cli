/**
 * CLI domain types and interfaces.
 */
export type { ToolDiff, ToolResult } from '../shared/types'
import type { ToolResult } from '../shared/types'

export type CliProvider =
  | 'oauth'
  | 'antigravity'
  | 'claude-subscription'
  | 'gemini-subscription'
  | 'codex-subscription'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'deepseek'
  | 'ollama'
  | 'copilot'
  | 'custom'

export interface CliConfig {
  provider?: CliProvider
  model?: string
  anthropicApiKey?: string
  openAiApiKey?: string
  geminiApiKey?: string
  openRouterApiKey?: string
  groqApiKey?: string
  deepSeekApiKey?: string
  ollamaBaseUrl?: string
  customBaseUrl?: string
  customApiKey?: string
  autoApprove?: boolean
  verbose?: boolean
  mode?: 'agent' | 'plan'
}

export interface CliMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: string
  }>
}

export interface CliTurnUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
}

export interface CliTaskItem {
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface CliSessionData {
  id: string
  createdAt: number
  updatedAt: number
  cwd: string
  provider: CliProvider
  model: string
  messages: CliMessage[]
  totalUsage: CliTurnUsage
  mode?: 'agent' | 'plan'
  title?: string
  tasks?: CliTaskItem[]
  contextLimit?: number
}

export type ToolApprovalDecision = 'yes' | 'no' | 'always' | 'stop'

export interface CliToolContext {
  cwd: string
  sessionId: string
  signal?: AbortSignal
  onChunk?: (chunk: string) => void
  askApproval?: (
    toolName: string,
    input: Record<string, unknown>,
    preview?: string
  ) => Promise<ToolApprovalDecision>
  autoApprove?: boolean
  verbose?: boolean
  mode?: 'agent' | 'plan'
  session?: CliSessionData
  runSubagent?: (
    subagentType: 'explore' | 'general',
    description: string,
    prompt: string
  ) => Promise<string>
}

export interface CliToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  mutates: boolean
  run: (input: Record<string, unknown>, ctx: CliToolContext) => Promise<ToolResult>
}
