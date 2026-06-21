#!/usr/bin/env node

const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = process.cwd()
const DEFAULT_MAX_LINES = 650
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])

// Most files should stay under the default budget. A few orchestration/root UI
// files get documented ceilings so the check remains a ratchet instead of a
// blunt refactor trigger.
const FILE_BUDGETS = new Map([
  [
    'src/main/models/ChatService.ts',
    {
      max: 800,
      reason:
        'temporary orchestration budget while provider routing, contract traces, and Codex handoff are split out'
    }
  ],
  [
    'src/renderer/components/ChatPanel.tsx',
    {
      max: 650,
      reason: 'root chat surface'
    }
  ]
])

function extname(file) {
  const i = file.lastIndexOf('.')
  return i === -1 ? '' : file.slice(i)
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, files)
    else if (EXTENSIONS.has(extname(entry))) files.push(path)
  }
  return files
}

const oversized = []
const rows = walk(ROOT)
  .map((file) => {
    const rel = relative(ROOT, file)
    const lineCount = readFileSync(file, 'utf8').split(/\r?\n/).length
    const budget = FILE_BUDGETS.get(rel)
    const max = budget?.max ?? DEFAULT_MAX_LINES
    if (lineCount > max) oversized.push({ rel, lineCount, max })
    return { rel, lineCount, max, reason: budget?.reason }
  })
  .sort((a, b) => b.lineCount - a.lineCount)

console.log('Largest source files:')
for (const row of rows.slice(0, 12)) {
  const marker = row.lineCount > row.max ? 'OVER' : 'ok'
  const note = row.reason ? ` (${row.reason})` : ''
  console.log(`${String(row.lineCount).padStart(5)} / ${String(row.max).padStart(4)} ${marker}  ${row.rel}${note}`)
}

if (oversized.length > 0) {
  console.error('\nFile size budget exceeded:')
  for (const row of oversized) {
    console.error(`- ${row.rel}: ${row.lineCount} lines > ${row.max}`)
  }
  process.exit(1)
}
