export interface DiffSummary {
  /** Lines that exist after but not before (added). */
  added: number
  /** Lines that existed before but not after (removed). */
  removed: number
  /** A compact unified-ish preview, capped. */
  preview: string
}

const MAX_PREVIEW_LINES = 12

/**
 * Counts how many times `needle` appears in `haystack` without overlap. Used
 * to enforce edit() uniqueness — if `oldString` matches more than once, the
 * model has to add surrounding context or set replaceAll explicitly.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    count++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return count
}

/**
 * Cheap line-level diff: counts unique add/remove lines with multiset
 * accounting (so a moved-but-unchanged line nets to zero) and renders a
 * short "what's new" preview. Not a true LCS diff — we only need the
 * model to see *what changed*, not where, and full diffs would balloon
 * tool-result payloads.
 */
export function diffSummary(before: string, after: string): DiffSummary {
  if (before === after) return { added: 0, removed: 0, preview: '(no change)' }
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  const beforeSet = new Map<string, number>()
  for (const l of a) beforeSet.set(l, (beforeSet.get(l) ?? 0) + 1)
  const afterSet = new Map<string, number>()
  for (const l of b) afterSet.set(l, (afterSet.get(l) ?? 0) + 1)

  let added = 0
  let removed = 0
  for (const [l, n] of afterSet) added += Math.max(0, n - (beforeSet.get(l) ?? 0))
  for (const [l, n] of beforeSet) removed += Math.max(0, n - (afterSet.get(l) ?? 0))

  const addedLines: string[] = []
  for (const l of b) {
    if ((beforeSet.get(l) ?? 0) <= 0) {
      addedLines.push(`+ ${l}`)
      if (addedLines.length >= MAX_PREVIEW_LINES) break
    } else {
      beforeSet.set(l, (beforeSet.get(l) ?? 0) - 1)
    }
  }
  const preview = addedLines.length
    ? addedLines.join('\n')
    : `(${added} added, ${removed} removed)`
  return { added, removed, preview }
}
