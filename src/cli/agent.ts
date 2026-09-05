/**
 * CLI Autonomous Agent Loop.
 * Handles continuous tool-calling turns, subagent delegation, MCP integration,
 * user approvals, execution, and history folding.
 */
import type { ToolDiff } from '../shared/types'
import type {
  CliMessage,
  CliProvider,
  CliSessionData,
  CliToolContext,
  CliTurnUsage,
  ToolApprovalDecision
} from './types'
import {
  CLI_TOOLS,
  callMcpTool,
  isMcpTool,
  loadWorkspaceMcpServers,
  ensureMcpConnected
} from './tools'
import { streamChatTurn, type ProviderDeltaEvent } from './providers'
import { buildCliSystemPrompt } from './prompt'
import { pruneToolOutputs } from './compaction'

export interface RunAgentTurnOptions {
  sessionId: string
  cwd: string
  provider: CliProvider
  model: string
  apiKey: string
  baseUrl?: string
  messages: CliMessage[]
  autoApprove?: boolean
  verbose?: boolean
  mode?: 'agent' | 'plan'
  session?: CliSessionData
  signal?: AbortSignal
  onTextChunk?: (delta: string) => void
  onReasoningChunk?: (delta: string) => void
  onToolStart?: (
    toolName: string,
    id: string,
    argsText: string,
    argsObj?: Record<string, unknown>
  ) => void
  onToolEnd?: (
    toolName: string,
    id: string,
    ok: boolean,
    output: string,
    diff?: ToolDiff,
    argsObj?: Record<string, unknown>
  ) => void
  askApproval?: (
    toolName: string,
    input: Record<string, unknown>,
    preview?: string
  ) => Promise<ToolApprovalDecision>
}

export interface RunAgentTurnResult {
  ok: boolean
  messages: CliMessage[]
  usage: CliTurnUsage
  error?: string
}

let mcpInitialized = false

export async function runCliAgentTurn(opts: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  const {
    sessionId,
    cwd,
    provider,
    model,
    apiKey,
    baseUrl,
    autoApprove = false,
    verbose = false,
    mode = 'agent',
    session,
    signal,
    onTextChunk,
    onReasoningChunk,
    onToolStart,
    onToolEnd,
    askApproval
  } = opts

  // Connect any workspace MCP servers on first turn
  if (!mcpInitialized) {
    try {
      const workspaceServers = loadWorkspaceMcpServers(cwd)
      if (workspaceServers.length > 0) {
        await ensureMcpConnected(workspaceServers, cwd)
      }
    } catch {
      // Ignore initial MCP connection errors
    }
    mcpInitialized = true
  }

  // Clone messages array
  const messages: CliMessage[] = [...opts.messages]

  // Ensure system prompt is present
  if (messages.length === 0 || messages[0].role !== 'system') {
    const systemPrompt = await buildCliSystemPrompt({ cwd, model, provider, mode })
    messages.unshift({ role: 'system', content: systemPrompt })
  }

  const totalUsage: CliTurnUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  }

  let turnCount = 0
  const MAX_TURNS = 50

  const toolCtx: CliToolContext = {
    cwd,
    sessionId,
    signal,
    askApproval,
    autoApprove,
    verbose,
    mode,
    session,
    runSubagent: async (subagentType, description, prompt) => {
      const subagentSystemPrompt = `You are a specialized subagent delegated a focused task by the lead agent.\nTask: ${description}\nType: ${subagentType}\n\nYou have NO memory of the prior conversation — work strictly from the task prompt.\nProvide a clear, direct, and complete final report.`
      const subMessages: CliMessage[] = [
        { role: 'system', content: subagentSystemPrompt },
        { role: 'user', content: prompt }
      ]
      const subRes = await runCliAgentTurn({
        sessionId: `${sessionId}_sub_${Date.now()}`,
        cwd,
        provider,
        model,
        apiKey,
        baseUrl,
        // Inherit the parent's consent settings rather than forcing them open.
        // A subagent runs with the same toolset as its parent, so auto-approving
        // here would let any `task` call become a blanket permission bypass.
        autoApprove,
        askApproval,
        verbose,
        mode: subagentType === 'explore' ? 'plan' : mode,
        signal,
        messages: subMessages
      })
      const lastAssistant = subRes.messages.filter((m) => m.role === 'assistant').pop()
      return (
        lastAssistant?.content ||
        subRes.error ||
        '(Subagent completed without generating text output)'
      )
    }
  }

  while (turnCount < MAX_TURNS) {
    if (signal?.aborted) {
      return { ok: false, messages, usage: totalUsage, error: 'Turn cancelled by user.' }
    }

    turnCount++

    let currentText = ''
    const currentToolCalls = new Map<string, { id: string; name: string; args: string }>()

    try {
      await streamChatTurn({
        provider,
        model,
        apiKey,
        baseUrl,
        messages,
        mode,
        signal,
        onEvent: (event: ProviderDeltaEvent) => {
          if (event.type === 'text') {
            currentText += event.delta
            if (onTextChunk) onTextChunk(event.delta)
          } else if (event.type === 'reasoning') {
            if (onReasoningChunk) onReasoningChunk(event.delta)
          } else if (event.type === 'tool_call_start') {
            currentToolCalls.set(event.id, {
              id: event.id,
              name: event.name,
              args: ''
            })
          } else if (event.type === 'tool_call_delta') {
            const tc = currentToolCalls.get(event.id)
            if (tc) {
              tc.args += event.argsDelta
            }
          } else if (event.type === 'tool_call_end') {
            // Tool call completed stream
          } else if (event.type === 'usage') {
            totalUsage.promptTokens += event.promptTokens
            totalUsage.completionTokens += event.completionTokens
            totalUsage.totalTokens += event.totalTokens
            if (event.cacheReadTokens) {
              totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens || 0) + event.cacheReadTokens
            }
            if (event.cacheWriteTokens) {
              totalUsage.cacheWriteTokens =
                (totalUsage.cacheWriteTokens || 0) + event.cacheWriteTokens
            }
          }
        }
      })
    } catch (err) {
      const errorMsg = (err as Error).message
      return { ok: false, messages, usage: totalUsage, error: errorMsg }
    }

    const toolCallsList = Array.from(currentToolCalls.values()).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.args
    }))

    // Add assistant turn to history
    messages.push({
      role: 'assistant',
      content: currentText,
      toolCalls: toolCallsList.length > 0 ? toolCallsList : undefined
    })

    // If no tool calls were requested, the model has finished its response
    if (toolCallsList.length === 0) {
      break
    }

    // Execute each tool call in sequence
    for (const tc of toolCallsList) {
      if (signal?.aborted) {
        return { ok: false, messages, usage: totalUsage, error: 'Turn cancelled by user.' }
      }

      let parsedArgs: Record<string, unknown> = {}
      try {
        if (tc.arguments) {
          parsedArgs = JSON.parse(tc.arguments)
        }
      } catch {
        parsedArgs = {}
      }

      if (onToolStart) {
        onToolStart(tc.name, tc.id, tc.arguments, parsedArgs)
      }

      let ok = false
      let output = ''
      let diff: ToolDiff | undefined

      // Route to MCP or built-in tool
      if (isMcpTool(tc.name)) {
        try {
          const res = await callMcpTool(tc.name, parsedArgs)
          ok = res.ok
          output = res.output
        } catch (e) {
          ok = false
          output = `MCP execution error for "${tc.name}": ${(e as Error).message}`
        }
      } else {
        const tool = CLI_TOOLS[tc.name]
        if (!tool) {
          output = `Error: Tool "${tc.name}" is not recognized or available in CLI.`
        } else if (mode === 'plan' && tool.mutates) {
          // Filtering the schema only tells the model what to ask for; the
          // dispatcher is what actually decides. A model can still name a
          // mutating tool from memory, from replayed history, or because it
          // was injected — so plan mode is enforced HERE, at execution.
          output =
            `Error: Tool "${tc.name}" modifies state and is blocked in plan mode. ` +
            `Present the plan and let the user approve leaving plan mode first.`
        } else {
          try {
            const res = await tool.run(parsedArgs, toolCtx)
            ok = res.ok
            output = res.output
            diff = res.diff
          } catch (e) {
            ok = false
            output = `Error executing tool "${tc.name}": ${(e as Error).message}`
          }
        }
      }

      if (onToolEnd) {
        onToolEnd(tc.name, tc.id, ok, output, diff, parsedArgs)
      }

      // Add tool output to conversation
      messages.push({
        role: 'tool',
        name: tc.name,
        toolCallId: tc.id,
        content: output
      })
    }

    // Prune older bulky tool outputs to conserve context window
    if (messages.length > 8) {
      const pruned = pruneToolOutputs(messages)
      messages.length = 0
      messages.push(...pruned)
    }
  }

  return {
    ok: true,
    messages,
    usage: totalUsage
  }
}
