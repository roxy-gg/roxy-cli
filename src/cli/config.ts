/**
 * CLI Configuration & Credential Management.
 * Resolves settings from ~/.roxy/cli.json, local .env files, and environment variables.
 */
import { existsSync, readFileSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliConfig, CliProvider } from './types'
import { listOAuthAccounts } from './oauth'

const CONFIG_DIR = path.join(os.homedir(), '.roxy')
const CONFIG_FILE = path.join(CONFIG_DIR, 'cli.json')

/** Parse a simple .env file into key-value pairs without external dependencies. */
export function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!existsSync(filePath)) return result
  try {
    const text = readFileSync(filePath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      result[key] = val
    }
  } catch {
    // Ignore unreadable .env
  }
  return result
}

/** Load stored configuration from ~/.roxy/cli.json. */
export function loadStoredConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(raw) as CliConfig
  } catch {
    return {}
  }
}

/** Save configuration to ~/.roxy/cli.json. */
export async function saveStoredConfig(config: CliConfig): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true })
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    console.warn(`[config] Failed to save ~/.roxy/cli.json: ${(e as Error).message}`)
  }
}

/** Default models per provider. */
export const DEFAULT_MODELS: Record<CliProvider, string> = {
  oauth: 'gemini-3.8-flash-high',
  antigravity: 'gemini-3.8-flash-high',
  'gemini-subscription': 'gemini-3.8-flash-high',
  'claude-subscription': 'claude-3-7-sonnet-20250219',
  'codex-subscription': 'gpt-4o',
  anthropic: 'claude-3-7-sonnet-20250219',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-3.7-sonnet',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  ollama: 'deepseek-r1:latest',
  copilot: 'gpt-4o',
  custom: 'gpt-4o'
}

/** Check if a provider uses OAuth via CLIProxyAPI sidecar. */
export function isOAuthProvider(p: CliProvider): boolean {
  return (
    p === 'oauth' ||
    p === 'antigravity' ||
    p === 'gemini-subscription' ||
    p === 'claude-subscription' ||
    p === 'codex-subscription'
  )
}

/**
 * Resolve effective configuration by merging:
 * 1. CLI flags (overrides)
 * 2. Process environment variables
 * 3. Local .env in cwd
 * 4. Stored config in ~/.roxy/cli.json
 */
export function resolveConfig(
  cwd: string,
  overrides: Partial<CliConfig> = {}
): {
  provider: CliProvider
  model: string
  apiKey: string
  baseUrl?: string
  autoApprove: boolean
  verbose: boolean
} {
  const stored = loadStoredConfig()
  const localEnv = parseEnvFile(path.join(cwd, '.env'))

  const getVal = (key: string, storedVal?: string): string => {
    return process.env[key] || localEnv[key] || storedVal || ''
  }

  const anthropicKey = getVal('ANTHROPIC_API_KEY', stored.anthropicApiKey)
  const openAiKey = getVal('OPENAI_API_KEY', stored.openAiApiKey)
  const geminiKey = getVal('GEMINI_API_KEY', stored.geminiApiKey) || getVal('GOOGLE_API_KEY')
  const openRouterKey = getVal('OPENROUTER_API_KEY', stored.openRouterApiKey)
  const groqKey = getVal('GROQ_API_KEY', stored.groqApiKey)
  const deepSeekKey = getVal('DEEPSEEK_API_KEY', stored.deepSeekApiKey)
  const ollamaUrl = getVal('OLLAMA_BASE_URL', stored.ollamaBaseUrl) || 'http://localhost:11434'
  const customUrl = getVal('CUSTOM_BASE_URL', stored.customBaseUrl)
  const customKey = getVal('CUSTOM_API_KEY', stored.customApiKey)

  // Determine provider
  let provider: CliProvider = overrides.provider || stored.provider || 'anthropic'
  const oauthAccounts = listOAuthAccounts()

  if (!overrides.provider && !stored.provider) {
    if (anthropicKey) provider = 'anthropic'
    else if (openAiKey) provider = 'openai'
    else if (geminiKey) provider = 'gemini'
    else if (openRouterKey) provider = 'openrouter'
    else if (groqKey) provider = 'groq'
    else if (deepSeekKey) provider = 'deepseek'
    else if (process.env.OLLAMA_BASE_URL) provider = 'ollama'
    else if (oauthAccounts.length > 0) {
      // Default to OAuth if accounts are signed in
      const hasGemini = oauthAccounts.some((a) => a.upstream === 'antigravity')
      const hasClaude = oauthAccounts.some((a) => a.upstream === 'claude')
      const hasCodex = oauthAccounts.some((a) => a.upstream === 'codex')
      if (hasGemini) provider = 'antigravity'
      else if (hasClaude) provider = 'claude-subscription'
      else if (hasCodex) provider = 'codex-subscription'
      else provider = 'oauth'
    }
  }

  let apiKey = ''
  let baseUrl: string | undefined

  if (isOAuthProvider(provider)) {
    // Sidecar will provide baseUrl and apiKey at runtime in main/index
    apiKey = 'oauth'
  } else {
    switch (provider) {
      case 'anthropic':
        apiKey = anthropicKey
        break
      case 'openai':
        apiKey = openAiKey
        break
      case 'gemini':
        apiKey = geminiKey
        break
      case 'openrouter':
        apiKey = openRouterKey
        baseUrl = 'https://openrouter.ai/api/v1'
        break
      case 'groq':
        apiKey = groqKey
        baseUrl = 'https://api.groq.com/openai/v1'
        break
      case 'deepseek':
        apiKey = deepSeekKey
        baseUrl = 'https://api.deepseek.com/v1'
        break
      case 'ollama':
        baseUrl = (ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '')
        break
      case 'custom':
        apiKey = customKey
        baseUrl = customUrl
        break
    }
  }

  const model =
    overrides.model || stored.model || DEFAULT_MODELS[provider] || 'claude-3-7-sonnet-20250219'
  const autoApprove = overrides.autoApprove ?? stored.autoApprove ?? false
  const verbose = overrides.verbose ?? stored.verbose ?? false

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    autoApprove,
    verbose
  }
}
