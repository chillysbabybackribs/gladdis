/**
 * Robust JSON-from-LLM-text extraction. Handles three common failure modes:
 *   1) Model returns clean JSON — fast path.
 *   2) Model wraps it in ```json ... ``` fences despite being told not to.
 *   3) Model prepends/appends prose around the JSON.
 *
 * On total failure returns null; never throws. Callers check the return type.
 */

export function extractJsonObject<T = unknown>(text: string): T | null {
  if (!text) return null

  // 1) Direct parse.
  try {
    return JSON.parse(text) as T
  } catch {
    /* fall through */
  }

  // 2) Strip markdown fences.
  const fenced = text.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/)
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]) as T
    } catch {
      /* fall through */
    }
  }

  // 3) Find the first balanced { ... } block.
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}
