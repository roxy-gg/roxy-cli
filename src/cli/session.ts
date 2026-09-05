/**
 * CLI Session Persistence & History Management.
 * Saves conversations to ~/.roxy/sessions/<id>.json and allows resuming.
 */
import { existsSync, readdirSync, readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliMessage, CliProvider, CliSessionData, CliTurnUsage } from './types'

const SESSIONS_DIR = path.join(os.homedir(), '.roxy', 'sessions')

function generateSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = 'ses_'
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

export function createNewSession(
  cwd: string,
  provider: CliProvider,
  model: string
): CliSessionData {
  const now = Date.now()
  return {
    id: generateSessionId(),
    createdAt: now,
    updatedAt: now,
    cwd,
    provider,
    model,
    messages: [],
    totalUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0
    }
  }
}

export async function saveSession(session: CliSessionData): Promise<void> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    session.updatedAt = Date.now()
    const filePath = path.join(SESSIONS_DIR, `${session.id}.json`)
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8')
  } catch (e) {
    console.warn(`[session] Failed to save session: ${(e as Error).message}`)
  }
}

export function loadSession(id: string): CliSessionData | null {
  const cleanId = id.replace(/\.json$/i, '')
  const filePath = path.join(SESSIONS_DIR, `${cleanId}.json`)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as CliSessionData
  } catch {
    return null
  }
}

export function listRecentSessions(
  limit = 10
): Array<{ id: string; updatedAt: number; cwd: string; model: string }> {
  if (!existsSync(SESSIONS_DIR)) return []
  try {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    const list: Array<{ id: string; updatedAt: number; cwd: string; model: string }> = []
    for (const file of files) {
      try {
        const raw = readFileSync(path.join(SESSIONS_DIR, file), 'utf8')
        const data = JSON.parse(raw) as CliSessionData
        list.push({
          id: data.id,
          updatedAt: data.updatedAt,
          cwd: data.cwd,
          model: `${data.provider}/${data.model}`
        })
      } catch {
        // Skip corrupted session files
      }
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list.slice(0, limit)
  } catch {
    return []
  }
}

/** Update session usage tallies and estimate cost in USD. */
export function updateSessionUsage(session: CliSessionData, turnUsage: CliTurnUsage): void {
  session.totalUsage.promptTokens += turnUsage.promptTokens
  session.totalUsage.completionTokens += turnUsage.completionTokens
  session.totalUsage.totalTokens += turnUsage.totalTokens
  if (turnUsage.cacheReadTokens) {
    session.totalUsage.cacheReadTokens =
      (session.totalUsage.cacheReadTokens || 0) + turnUsage.cacheReadTokens
  }
  if (turnUsage.cacheWriteTokens) {
    session.totalUsage.cacheWriteTokens =
      (session.totalUsage.cacheWriteTokens || 0) + turnUsage.cacheWriteTokens
  }

  // Rough estimation: $3/M input, $15/M output for flagship models.
  // Cached prompt reads are 90% cheaper ($0.30/M) via Anthropic Prompt Caching.
  const inRate = session.model.includes('3-7') || session.model.includes('4o') ? 3.0 : 1.0
  const outRate = session.model.includes('3-7') || session.model.includes('4o') ? 15.0 : 4.0

  const promptCached = turnUsage.cacheReadTokens || 0
  const promptFresh = Math.max(0, turnUsage.promptTokens - promptCached)

  const turnCost =
    (promptFresh / 1_000_000) * inRate +
    (promptCached / 1_000_000) * (inRate * 0.1) +
    (turnUsage.completionTokens / 1_000_000) * outRate
  session.totalUsage.cost = (session.totalUsage.cost || 0) + turnCost
}

/** Format conversation messages for context display or compacting. */
export function compactMessages(messages: CliMessage[]): CliMessage[] {
  if (messages.length <= 10) return messages
  const system = messages.filter((m) => m.role === 'system')
  // Never begin the kept tail with a `tool` message: its originating
  // `assistant` tool_call would be gone, which both provider APIs reject
  // with a 400. Walk the boundary forward to the next non-tool message.
  let cut = messages.length - 8
  while (cut < messages.length && messages[cut].role === 'tool') cut++
  const recent = messages.slice(cut)
  const middle = messages.slice(system.length, cut)

  const summary = `[Compacted ${middle.length} earlier messages to conserve context window]`
  return [
    ...system,
    { role: 'user', content: summary },
    {
      role: 'assistant',
      content:
        'Understood. I will continue assisting based on the remaining context and recent turns.'
    },
    ...recent
  ]
}
