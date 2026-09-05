# Roxy CLI

An autonomous terminal AI coding agent: it reads your code, edits files, runs
commands, and iterates on the result — all from the shell.

> **Status: v0.1.0, early.** The core agent loop is solid and the security
> boundaries below are tested, but expect rough edges in the REPL. See
> [Known limitations](#known-limitations) before relying on it.

## Features

- **18 built-in tools** — `read`, `write`, `edit`, `list`, `glob`, `grep`,
  `bash` (incl. background processes), `webfetch`, `lsp`, `task`, `skill`,
  `mcp`, and more.
- **Live LSP diagnostics** — real type errors from the language server after
  each edit, not just what the model thinks the code does.
- **MCP support** — connect Model Context Protocol servers over stdio, SSE, or
  Streamable HTTP.
- **Skills** — drop a `SKILL.md` in `.roxy/skills/` (or `.claude/skills/`) to
  teach the agent a reusable workflow.
- **Bring your own model** — sign in with an existing subscription, point Roxy
  at any OpenAI-compatible endpoint, or run fully local with Ollama.
- **Prompt caching** — cache breakpoints cut cost and time-to-first-token
  substantially on multi-turn sessions.
- **Subagents** — delegate focused work to an `explore` (read-only) or
  `general` subagent.
- **Context compaction** — summarizes earlier turns automatically as the
  window fills.

## Install

```bash
npm install
npm run build
```

## Getting started

Roxy needs a model to talk to. Pick whichever path fits you:

### Sign in with a subscription

If you already pay for a plan, sign in once and Roxy uses it — no API key to
manage:

```bash
node bin/roxy.cjs login          # then follow the browser prompt
node bin/roxy.cjs accounts       # list signed-in accounts
```

### Use your own endpoint

Point Roxy at any OpenAI-compatible API — your own gateway, a self-hosted
model server, or a provider of your choice:

```bash
export CUSTOM_BASE_URL=https://your-endpoint.example/v1
export CUSTOM_API_KEY=your-key
node bin/roxy.cjs --provider custom
```

### Run fully local

No account, no key, nothing leaves your machine:

```bash
node bin/roxy.cjs --provider ollama        # defaults to http://localhost:11434
```

### Other providers

Roxy also reads a key from the environment, a local `.env`, or `~/.roxy/cli.json`
and picks the matching provider automatically. Supported: `openai`, `gemini`,
`openrouter`, `groq`, `deepseek`, `anthropic`, `custom`, `ollama`.

```bash
node bin/roxy.cjs --provider <name>        # force one explicitly
```

Run `node bin/roxy.cjs --help` for the full list of flags.

## Usage

```bash
# Interactive REPL
node bin/roxy.cjs

# Single-shot prompt
node bin/roxy.cjs -p "explain this codebase architecture"

# Pick a model
node bin/roxy.cjs -m <model-id>

# Plan mode: explore and propose, never modify
node bin/roxy.cjs --plan

# Skip approval prompts (see the warning below)
node bin/roxy.cjs --yes
```

## Security model

The agent acts on content it did not write — your files, web pages, MCP server
output — so that content is treated as untrusted input:

- **Filesystem access is confined to the workspace.** Every path a tool
  resolves is checked against the workspace root, absolute and relative alike,
  with symlink resolution on writes. Reading `~/.ssh/id_rsa` fails.
- **Destructive shell commands are screened.** `rm -rf /`, `curl … | sh`,
  `sudo`, force pushes and similar always prompt, *even with `--yes`*, and are
  refused outright in plan mode.
- **`webfetch` cannot reach the local network.** Loopback, link-local, private
  ranges, and cloud metadata endpoints (`169.254.169.254`) are rejected, which
  is what keeps the tool from becoming an SSRF and exfiltration primitive.
- **Plan mode is enforced at execution**, not just by hiding tools from the
  model. A mutating tool called in plan mode is refused by the dispatcher.
- **Subagents inherit their parent's approval settings** rather than running
  unattended.

Each of these has a regression test in `test/cli.ts`.

> **`--yes` still grants broad power.** It skips approval for ordinary file
> writes and commands. Use it in throwaway directories, containers, or CI —
> not in a checkout you care about.

## Known limitations

Honest list of what is not there yet:

- The REPL is `readline`-based: no persistent history, no slash-command
  autocomplete, and pasting multi-line text sends only the first line.
- No granular permission rules (allow/deny per tool and pattern) — approval is
  currently all-or-nothing.
- No OS-level sandbox around `bash`; the command screen is a backstop, not a
  jail.
- Credentials are stored in plaintext under `~/.roxy/` without restrictive
  file permissions.
- No retry/backoff on provider rate limits (429).

See `AUDIT.md` for the full assessment and the roadmap that follows from it.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # test suite (42 checks)
npm run check       # both
npm run build       # bundle to bin/roxy.cjs
```

## License

MIT — see [LICENSE](LICENSE).
