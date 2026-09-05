/**
 * Unified diff calculator & terminal ANSI diff renderer.
 */

export interface DiffLine {
  type: 'add' | 'del' | 'same'
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/** Compute a simple line-by-line unified diff between oldText and newText. */
export function computeLineDiff(oldText: string, newText: string): DiffHunk[] {
  const oldLines = oldText ? oldText.split(/\r?\n/) : []
  const newLines = newText ? newText.split(/\r?\n/) : []

  // LCS-based diff or simple greedy match
  const n = oldLines.length
  const m = newLines.length

  // Build LCS matrix (cap if too large)
  if (n * m > 2_500_000) {
    // Large file fallback: whole file replacement hunk
    return [
      {
        oldStart: 1,
        oldCount: n,
        newStart: 1,
        newCount: m,
        lines: [
          ...oldLines.map((l, i) => ({ type: 'del' as const, text: l, oldLineNumber: i + 1 })),
          ...newLines.map((l, i) => ({ type: 'add' as const, text: l, newLineNumber: i + 1 }))
        ]
      }
    ]
  }

  // Dynamic programming LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  // Backtrack to find diff
  let i = n
  let j = m
  const rawDiff: DiffLine[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawDiff.unshift({
        type: 'same',
        text: oldLines[i - 1],
        oldLineNumber: i,
        newLineNumber: j
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.unshift({
        type: 'add',
        text: newLines[j - 1],
        newLineNumber: j
      })
      j--
    } else if (i > 0) {
      rawDiff.unshift({
        type: 'del',
        text: oldLines[i - 1],
        oldLineNumber: i
      })
      i--
    }
  }

  // Group into hunks with up to 3 lines of context
  const CONTEXT = 3
  const hunks: DiffHunk[] = []
  let currentLines: DiffLine[] = []
  let lastChangeIdx = -1

  for (let idx = 0; idx < rawDiff.length; idx++) {
    const line = rawDiff[idx]
    if (line.type !== 'same') {
      if (lastChangeIdx === -1) {
        // Start new hunk: grab preceding context
        const startCtx = Math.max(0, idx - CONTEXT)
        currentLines = rawDiff.slice(startCtx, idx)
      }
      lastChangeIdx = idx
      currentLines.push(line)
    } else {
      if (lastChangeIdx !== -1) {
        currentLines.push(line)
        if (idx - lastChangeIdx >= CONTEXT * 2) {
          // Close hunk
          const hunkLines = currentLines.slice(0, currentLines.length - CONTEXT)
          if (hunkLines.some((l) => l.type !== 'same')) {
            hunks.push(buildHunk(hunkLines))
          }
          currentLines = []
          lastChangeIdx = -1
        }
      }
    }
  }

  if (currentLines.length > 0 && currentLines.some((l) => l.type !== 'same')) {
    hunks.push(buildHunk(currentLines))
  }

  return hunks
}

function buildHunk(lines: DiffLine[]): DiffHunk {
  let oldStart = 1
  let oldCount = 0
  let newStart = 1
  let newCount = 0

  const firstOld = lines.find((l) => l.oldLineNumber !== undefined)
  if (firstOld?.oldLineNumber) oldStart = firstOld.oldLineNumber

  const firstNew = lines.find((l) => l.newLineNumber !== undefined)
  if (firstNew?.newLineNumber) newStart = firstNew.newLineNumber

  for (const l of lines) {
    if (l.type === 'same' || l.type === 'del') oldCount++
    if (l.type === 'same' || l.type === 'add') newCount++
  }

  return { oldStart, oldCount, newStart, newCount, lines }
}

/** Render a unified diff with ANSI terminal colors. */
export function formatDiffAnsi(filePath: string, oldText: string, newText: string): string {
  const hunks = computeLineDiff(oldText, newText)
  if (hunks.length === 0) return ''

  const RESET = '\x1b[0m'
  const BOLD = '\x1b[1m'
  const DIM = '\x1b[2m'
  const RED = '\x1b[31m'
  const GREEN = '\x1b[32m'
  const CYAN = '\x1b[36m'

  const out: string[] = []
  out.push(`${BOLD}${CYAN}--- ${filePath} (original)${RESET}`)
  out.push(`${BOLD}${CYAN}+++ ${filePath} (modified)${RESET}`)

  for (const hunk of hunks) {
    out.push(
      `${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}`
    )
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        const num = String(line.newLineNumber ?? '').padStart(4)
        out.push(`${GREEN}+ ${DIM}${num} | ${RESET}${GREEN}${line.text}${RESET}`)
      } else if (line.type === 'del') {
        const num = String(line.oldLineNumber ?? '').padStart(4)
        out.push(`${RED}- ${DIM}${num} | ${RESET}${RED}${line.text}${RESET}`)
      } else {
        const num = String(line.newLineNumber ?? '').padStart(4)
        out.push(`${DIM}  ${num} | ${line.text}${RESET}`)
      }
    }
  }

  return out.join('\n')
}
