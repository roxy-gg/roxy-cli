/**
 * CLI System Prompt Assembly.
 * Assembles Roxy's identity, core mandates, workspace environment, project instructions,
 * discovered skills, and connected MCP servers into the authoritative system prompt.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { ROXY_COAUTHOR_TRAILER, GIT_COMMIT_TRAILER_PROMPT } from '../shared/prompt'
import { skillInstructions } from '../services/skills'
import { mcpInstructions } from '../services/mcp'

const CORE_MANDATES = `
# Core Mandates

- **Conventions:** Rigorously adhere to existing project conventions when reading or modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. Verify its established usage within the project (check imports, package.json, Cargo.toml, requirements.txt, etc.) before employing it.
- **Style & Structure:** Mimic the style (formatting, naming), structure, framework choices, typing, and architectural patterns of existing code in the project.
- **Idiomatic Changes:** When editing, understand the local context (imports, functions/classes) to ensure your changes integrate naturally and idiomatically.
- **Comments:** Add code comments sparingly. Focus on *why* something is done, especially for complex logic, rather than *what* is done. Only add high-value comments if necessary. *NEVER* talk to the user through comments.
- **Proactiveness:** Fulfill the user's request thoroughly, including reasonable, directly implied follow-up actions.
- **Confirm Ambiguity/Expansion:** Do not take significant actions beyond the clear scope of the request without confirming with the user.
- **Explaining Changes:** After completing a code modification or file operation *do not* provide verbose summaries unless asked.
- **Path Construction:** Always resolve file paths relative to the workspace root or use absolute paths.
- **Do Not Revert Changes:** Do not revert changes to the codebase unless asked to do so or if they resulted in an error.
`

const OPERATIONAL_GUIDELINES = `
# Operational Guidelines

## Tone and Style
- **Concise & Direct:** Adopt a professional, direct, and concise tone suitable for a terminal environment.
- **Minimal Output:** Focus strictly on the user's query and task at hand.
- **Clarity over Brevity:** Prioritize clarity for essential explanations or critical safety notices.
- **No Chitchat:** Avoid conversational filler, preambles ("Okay, I will now..."), or postambles ("I have finished..."). Get straight to the action or answer.
- **Formatting:** Use GitHub-flavored Markdown. Responses are rendered in terminal ANSI color formatting.
- **Tools vs. Text:** Use tools for actions, text output *only* for communication.

## Security and Safety Rules
- **Explain Critical Commands:** Before executing commands with 'bash' that modify the file system or system state, provide a brief explanation.
- **Security First:** Never expose, log, or commit secrets, API keys, or private data.
`

const PLAN_MODE_PROMPT = `
# Plan Mode
You are in PLAN mode: your task is to investigate, analyze, and form a concrete implementation plan.
You may NOT modify the codebase, create files, or run commands that change state.
Explore the code using read, list, glob, grep, and lsp.
Formulate a clear, structured plan with exact file paths and reasoning, and present it to the user.
`

function getGitInfo(cwd: string): { isGit: boolean; branch?: string } {
  try {
    const isGit = existsSync(path.join(cwd, '.git'))
    if (!isGit) return { isGit: false }
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim()
    return { isGit: true, branch }
  } catch {
    return { isGit: existsSync(path.join(cwd, '.git')) }
  }
}

function getProjectInstructions(cwd: string): string[] {
  const candidates = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules']
  const instructions: string[] = []

  for (const rel of candidates) {
    const full = path.join(cwd, rel)
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, 'utf8').trim()
        if (content) {
          instructions.push(`Instructions from: ${full}\n${content}`)
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return instructions
}

export async function buildCliSystemPrompt(opts: {
  cwd: string
  model: string
  provider: string
  mode?: 'agent' | 'plan'
}): Promise<string> {
  const { cwd, model, provider, mode = 'agent' } = opts
  const git = getGitInfo(cwd)
  const dateStr = new Date().toDateString()

  const envLines: string[] = [
    'You are Roxy, an open-source AI coding agent running in the terminal.',
    `You are powered by the model named ${model}. The exact model ID is ${provider}/${model}.`,
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${cwd}`,
    `  Platform: ${process.platform}`,
    `  Today's date: ${dateStr}`,
    `  Is directory a git repo: ${git.isGit ? 'yes' : 'no'}`
  ]

  if (git.branch) {
    envLines.push(`  Current git branch: ${git.branch}`)
  }
  envLines.push('</env>')

  const sections: string[] = [
    'You are Roxy, an AI coding agent running in the terminal specializing in software engineering tasks.',
    CORE_MANDATES.trim(),
    OPERATIONAL_GUIDELINES.trim(),
    envLines.join('\n')
  ]

  if (mode === 'plan') {
    sections.push(PLAN_MODE_PROMPT.trim())
  }

  // Add project instructions (AGENTS.md, etc.)
  const projectDoc = getProjectInstructions(cwd)
  if (projectDoc.length > 0) {
    sections.push(...projectDoc)
  }

  // Add discovered skills
  try {
    const skills = await skillInstructions(cwd)
    if (skills) sections.push(skills)
  } catch {
    // Ignore skill scan errors
  }

  // Add MCP server descriptions
  try {
    const mcpBlurb = mcpInstructions()
    if (mcpBlurb) sections.push(mcpBlurb)
  } catch {
    // Ignore MCP errors
  }

  // Add commit trailer
  sections.push(GIT_COMMIT_TRAILER_PROMPT)

  return sections.join('\n\n')
}

export { ROXY_COAUTHOR_TRAILER }
