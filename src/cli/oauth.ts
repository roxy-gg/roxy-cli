/**
 * CLI OAuth & CLIProxyAPI Sidecar Integration.
 * Allows Roxy CLI to spend the user's existing OAuth subscriptions:
 *   - Google/Gemini (Antigravity OAuth)
 *   - Claude / Anthropic (Claude OAuth)
 *   - ChatGPT / Codex (OpenAI OAuth)
 *   - GitHub Copilot (Device Flow OAuth)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  CLIPROXY_VERSION,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  CLAUDE_PROVIDER_ID,
  CLIPROXY_UPSTREAMS,
  type CliProxyUpstream,
  type CliProxyUpstreamSpec
} from '../shared/cliproxy'

const HOST = '127.0.0.1'
const PORT_RANGE_START = 8317
const PORT_RANGE_END = 8399
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_POLL_MS = 1000

export interface OAuthAccount {
  upstream: CliProxyUpstream
  providerId: string
  email: string
  file: string
  label: string
}

export interface SidecarState {
  running: boolean
  port: number | null
  baseUrl: string | null
  apiKey: string | null
  managementKey: string | null
  child: ChildProcess | null
}

const sidecarState: SidecarState = {
  running: false,
  port: null,
  baseUrl: null,
  apiKey: null,
  managementKey: null,
  child: null
}

/** Find the directory where Roxy stores CLIProxyAPI data. */
export function getCliProxyRootDir(): string {
  const candidates: string[] = []

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    candidates.push(path.join(appdata, 'roxy', 'cliproxy'))
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'roxy', 'cliproxy'))
  } else {
    candidates.push(path.join(os.homedir(), '.config', 'roxy', 'cliproxy'))
  }

  candidates.push(path.join(os.homedir(), '.roxy', 'cliproxy'))

  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  return candidates[0]
}

export function getAuthDir(): string {
  return path.join(getCliProxyRootDir(), 'auths')
}

export function getInstallDir(): string {
  return path.join(getCliProxyRootDir(), `v${CLIPROXY_VERSION}`)
}

export function getBinPath(): string {
  const exe = process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
  return path.join(getInstallDir(), exe)
}

export function getConfigPath(): string {
  return path.join(getCliProxyRootDir(), 'config.yaml')
}

export function getSecretsPath(): string {
  return path.join(getCliProxyRootDir(), 'secrets.json')
}

/** Load local proxy secrets (apiKey + managementKey). */
export function loadSidecarSecrets(): { apiKey: string; managementKey: string } | null {
  const p = getSecretsPath()
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as { apiKey?: string; managementKey?: string }
    if (data.apiKey && data.managementKey) {
      return { apiKey: data.apiKey, managementKey: data.managementKey }
    }
  } catch {
    // Ignore
  }
  return null
}

/** List all active OAuth subscription accounts stored in auths/. */
export function listOAuthAccounts(): OAuthAccount[] {
  const authDir = getAuthDir()
  if (!existsSync(authDir)) return []

  const results: OAuthAccount[] = []
  try {
    const files = readdirSync(authDir).filter((f) => f.endsWith('.json'))
    for (const f of files) {
      // Filename format: <upstream>-<email>.json or <upstream>-<id>-<email>-<tier>.json
      let upstream: CliProxyUpstream | null = null
      let providerId = ''
      let label = ''

      if (f.startsWith('antigravity-')) {
        upstream = 'antigravity'
        providerId = GEMINI_PROVIDER_ID
        label = 'Google / Gemini (Antigravity)'
      } else if (f.startsWith('claude-')) {
        upstream = 'claude'
        providerId = CLAUDE_PROVIDER_ID
        label = 'Anthropic Claude'
      } else if (f.startsWith('codex-')) {
        upstream = 'codex'
        providerId = CODEX_PROVIDER_ID
        label = 'OpenAI ChatGPT / Codex'
      }

      if (upstream) {
        // Extract email if possible
        const clean = f.replace(/\.json$/, '').replace(new RegExp(`^${upstream}-`), '')
        let email = clean
        const emailMatch = clean.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
        if (emailMatch) {
          email = emailMatch[0]
        }

        results.push({
          upstream,
          providerId,
          email,
          file: f,
          label
        })
      }
    }
  } catch {
    // Ignore
  }
  return results
}

/** Check if a TCP port is free by binding it. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ port, host: HOST, exclusive: true })
  })
}

/** Find a free port in the range 8317-8399. */
async function pickFreePort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error('No free port found for CLIProxyAPI sidecar (8317-8399).')
}

/** Check if the sidecar is currently responding at the given port and apiKey. */
async function pingSidecar(port: number, apiKey: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1000)
    const res = await fetch(`http://${HOST}:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/** Write the config.yaml for the sidecar process. */
async function writeConfigFile(port: number, apiKey: string, managementKey: string): Promise<void> {
  const yaml = [
    '# Generated by Roxy CLI. Edits are overwritten on every start.',
    `host: "${HOST}"`,
    `port: ${port}`,
    `auth-dir: ${JSON.stringify(getAuthDir())}`,
    'api-keys:',
    `  - "${apiKey}"`,
    'remote-management:',
    '  allow-remote: false',
    `  secret-key: "${managementKey}"`,
    '  disable-control-panel: true',
    '  disable-auto-update-panel: true',
    'debug: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    'plugins:',
    '  enabled: false',
    ''
  ].join('\n')

  await fs.mkdir(getCliProxyRootDir(), { recursive: true })
  await fs.mkdir(getAuthDir(), { recursive: true })
  await fs.writeFile(getConfigPath(), yaml, 'utf8')
}

/**
 * Ensure CLIProxyAPI sidecar is running and return connection details.
 */
export async function ensureOAuthSidecarRunning(): Promise<{
  baseUrl: string
  apiKey: string
  port: number
  accounts: OAuthAccount[]
}> {
  const accounts = listOAuthAccounts()
  const secrets = loadSidecarSecrets()
  if (!secrets) {
    throw new Error(
      `No CLIProxy secrets found in ${getSecretsPath()}. Please log in via Roxy or run "roxy login".`
    )
  }

  // Check if already running in this process
  if (sidecarState.running && sidecarState.port && sidecarState.baseUrl) {
    return {
      baseUrl: sidecarState.baseUrl,
      apiKey: secrets.apiKey,
      port: sidecarState.port,
      accounts
    }
  }

  // Check if sidecar is already running externally (e.g. launched by Roxy desktop)
  let portToTest: number | null = null
  if (existsSync(getConfigPath())) {
    try {
      const cfg = readFileSync(getConfigPath(), 'utf8')
      const m = cfg.match(/^port:\s*(\d+)/m)
      if (m) portToTest = parseInt(m[1], 10)
    } catch {
      // Ignore
    }
  }

  if (portToTest && (await pingSidecar(portToTest, secrets.apiKey))) {
    sidecarState.running = true
    sidecarState.port = portToTest
    sidecarState.baseUrl = `http://${HOST}:${portToTest}/v1`
    sidecarState.apiKey = secrets.apiKey
    sidecarState.managementKey = secrets.managementKey
    return {
      baseUrl: sidecarState.baseUrl,
      apiKey: secrets.apiKey,
      port: portToTest,
      accounts
    }
  }

  // Also check ports in the window in case port moved
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_START + 5; p++) {
    if (await pingSidecar(p, secrets.apiKey)) {
      sidecarState.running = true
      sidecarState.port = p
      sidecarState.baseUrl = `http://${HOST}:${p}/v1`
      sidecarState.apiKey = secrets.apiKey
      sidecarState.managementKey = secrets.managementKey
      return {
        baseUrl: sidecarState.baseUrl,
        apiKey: secrets.apiKey,
        port: p,
        accounts
      }
    }
  }

  // Start the sidecar executable
  const bin = getBinPath()
  if (!existsSync(bin)) {
    throw new Error(
      `CLIProxyAPI binary not found at "${bin}". Please open Roxy Desktop once or run "roxy login".`
    )
  }

  const freePort = await pickFreePort()
  await writeConfigFile(freePort, secrets.apiKey, secrets.managementKey)

  const child = spawn(bin, ['-config', getConfigPath()], {
    cwd: getInstallDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  sidecarState.child = child

  // Wait for it to become healthy
  const deadline = Date.now() + 10_000
  let isHealthy = false
  while (Date.now() < deadline) {
    if (await pingSidecar(freePort, secrets.apiKey)) {
      isHealthy = true
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  if (!isHealthy) {
    try {
      child.kill()
    } catch {
      // Ignore
    }
    throw new Error(`CLIProxyAPI sidecar failed to start on port ${freePort} within 10s.`)
  }

  sidecarState.running = true
  sidecarState.port = freePort
  sidecarState.baseUrl = `http://${HOST}:${freePort}/v1`
  sidecarState.apiKey = secrets.apiKey
  sidecarState.managementKey = secrets.managementKey

  return {
    baseUrl: sidecarState.baseUrl,
    apiKey: secrets.apiKey,
    port: freePort,
    accounts
  }
}

/** Query the list of model IDs offered by the sidecar. */
export async function getSidecarModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!res.ok) return []
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    return (json.data || []).map((m) => m.id)
  } catch {
    return []
  }
}

/** Open a URL in the user's default browser cross-platform. */
export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', url], { windowsHide: true })
  } else if (process.platform === 'darwin') {
    spawn('open', [url])
  } else {
    spawn('xdg-open', [url])
  }
}

/**
 * Run OAuth login flow for a provider via CLIProxyAPI Management API.
 */
export async function runSidecarOAuthLogin(
  providerKey: 'antigravity' | 'claude' | 'codex'
): Promise<{ ok: boolean; email?: string; error?: string }> {
  const secrets = loadSidecarSecrets()
  if (!secrets) {
    return { ok: false, error: 'No sidecar secrets found.' }
  }

  const { port } = await ensureOAuthSidecarRunning()

  let spec: CliProxyUpstreamSpec
  if (providerKey === 'antigravity') {
    spec = CLIPROXY_UPSTREAMS[GEMINI_PROVIDER_ID]
  } else if (providerKey === 'claude') {
    spec = CLIPROXY_UPSTREAMS[CLAUDE_PROVIDER_ID]
  } else {
    spec = CLIPROXY_UPSTREAMS[CODEX_PROVIDER_ID]
  }

  const mgmtHeaders = {
    Authorization: `Bearer ${secrets.managementKey}`,
    'Content-Type': 'application/json'
  }

  // Request auth URL from sidecar
  const res = await fetch(`http://${HOST}:${port}${spec.authUrlPath}?is_webui=true`, {
    headers: mgmtHeaders
  })

  if (!res.ok) {
    const text = await res.text()
    return { ok: false, error: `Sidecar error (${res.status}): ${text}` }
  }

  const data = (await res.json()) as { url?: string; state?: string; error?: string }
  if (!data.url || !data.state) {
    return { ok: false, error: data.error || 'Failed to obtain authorization URL.' }
  }

  console.log(`\n  Opening browser for ${spec.accountLabel} OAuth login...`)
  console.log(`  If it does not open automatically, visit:`)
  console.log(`  \x1b[36m${data.url}\x1b[0m\n`)

  openBrowser(data.url)

  // Poll for completion
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const pollRes = await fetch(
        `http://${HOST}:${port}/get-auth-status?state=${encodeURIComponent(data.state)}`,
        { headers: mgmtHeaders }
      )
      if (pollRes.ok) {
        const pollData = (await pollRes.json()) as { status?: string; error?: string }
        if (pollData.status === 'ok') {
          const accounts = listOAuthAccounts()
          const matched = accounts.find((a) => a.upstream === providerKey)
          return { ok: true, email: matched?.email }
        }
        if (pollData.status === 'error') {
          return { ok: false, error: pollData.error || 'Login failed.' }
        }
      }
    } catch {
      // Continue polling
    }
    await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
  }

  return { ok: false, error: 'Timed out waiting for OAuth login.' }
}

/** Stop the CLIProxy sidecar if we spawned it. */
export function stopSidecar(): void {
  if (sidecarState.child) {
    try {
      sidecarState.child.kill()
    } catch {
      // Ignore
    }
    sidecarState.child = null
    sidecarState.running = false
  }
}
