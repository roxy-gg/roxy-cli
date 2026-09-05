/**
 * Shared domain types for the Roxy CLI.
 *
 * Pure types only — no Node or browser imports, so this module stays
 * isomorphic and testable from the pure-Node harness.
 */

/** A before/after snapshot of a single file, produced by the write/edit tools. */
export interface ToolDiff {
  /** Workspace-relative path of the changed file. */
  path: string
  /** File contents before the change ('' when the file was created). */
  before: string
  /** File contents after the change. */
  after: string
}

/** Result of running an agent tool — a plain string output (as an LLM tool returns). */
export interface ToolResult {
  ok: boolean
  output: string
  /** Optional inline image (data URL), e.g. a browser screenshot. */
  image?: string
  /** Before/after file contents (write/edit) so the UI can render a diff. */
  diff?: ToolDiff
}
