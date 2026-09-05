# Roxy CLI

Roxy CLI is an agentic coding tool that lives in your terminal. It understands
your codebase and helps you code faster through natural language commands — it
reads files, makes edits, runs commands, and iterates until the task is done.

Learn more at [roxy.gg](https://roxy.gg).

> **v0.1.0 — early.** The agent loop and the security boundaries below are
> tested. The REPL still has rough edges; see
> [Known limitations](#known-limitations).

## Get started

1. Install and build:

   ```sh
   npm install && npm run build
   ```

2. Add your Roxy API key — [create one here](https://roxy.gg/dashboard):

   ```sh
   export ROXY_API_KEY=rx-...
   ```

3. Navigate to your project and run it:

   ```sh
   cd /path/to/your/project
   node bin/roxy.cjs
   ```

One key gets you every frontier model — Anthropic, OpenAI, Google, Meta, GLM,
Kimi, DeepSeek, and Qwen — with pay-as-you-go pricing and no subscription. See
[pricing](https://roxy.gg/pricing).

Already pay for a plan elsewhere? Run `node bin/roxy.cjs login` to sign in with
an existing subscription, or `--provider ollama` to run fully local. Roxy also
reads `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`,
`DEEPSEEK_API_KEY`, and `ANTHROPIC_API_KEY` from your environment.

## What Roxy can do

- **Edit files and fix bugs** across your codebase
- **Answer questions** about your code's architecture and logic
- **Execute and fix** tests, linting, and other commands
- **Catch real type errors** via live LSP diagnostics after each edit — not
  just what the model thinks the code does
- **Extend itself** with MCP servers, `SKILL.md` workflows, and subagents

## Usage

```sh
# Start an interactive session
node bin/roxy.cjs

# Run a one-off prompt and exit
node bin/roxy.cjs -p "explain this codebase architecture"

# Plan mode — explore and propose, never modify
node bin/roxy.cjs --plan

# Resume your last session
node bin/roxy.cjs --resume

# Pipe data in
cat build-error.log | node bin/roxy.cjs "why did this fail?"
```

Run `node bin/roxy.cjs --help` for all flags, or `/help` inside a session for
slash commands.

## Extending Roxy

**Skills.** Drop a `SKILL.md` into `.roxy/skills/` (or `.claude/skills/`) to
teach Roxy a reusable workflow. It loads them on demand when relevant.

**MCP servers.** Connect Model Context Protocol servers over stdio, SSE, or
Streamable HTTP to give Roxy new tools and data sources.

**Subagents.** Delegate focused work to an `explore` (read-only) or `general`
subagent that reports back without cluttering the main conversation.

## Security

Roxy acts on content it did not write — your files, web pages, MCP server
output — so all of it is treated as untrusted input:

- **Filesystem access is confined to the workspace.** Every path is validated
  against the workspace root, absolute and relative alike, with symlink
  resolution on writes. Reading `~/.ssh/id_rsa` fails.
- **Destructive commands are screened.** `rm -rf /`, `curl … | sh`, `sudo`, and
  force pushes always prompt — *even with `--yes`* — and are refused in plan
  mode.
- **`webfetch` cannot reach the local network.** Loopback, link-local, private
  ranges, and cloud metadata endpoints (`169.254.169.254`) are rejected, which
  keeps the tool from becoming an SSRF and exfiltration primitive.
- **Plan mode is enforced at execution**, not just by hiding tools from the
  model.
- **Subagents inherit their parent's approval settings** rather than running
  unattended.

Each has a regression test in `test/cli.ts`.

> **`--yes` grants broad power.** It skips approval for ordinary edits and
> commands. Use it in throwaway directories, containers, or CI — not in a
> checkout you care about.

## Known limitations

- The REPL is `readline`-based: no persistent history, no slash-command
  autocomplete, and pasting multi-line text sends only the first line.
- Permissions are all-or-nothing; no per-tool allow/deny rules yet.
- No OS-level sandbox around `bash` — the command screen is a backstop, not a
  jail.
- Credentials are stored in plaintext under `~/.roxy/` without restrictive file
  permissions.
- No retry/backoff on provider rate limits (429).

See [`AUDIT.md`](AUDIT.md) for the full assessment and the roadmap.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # 42 checks
npm run check       # both
npm run build       # bundle to bin/roxy.cjs
```

## License

MIT — see [LICENSE](LICENSE).
