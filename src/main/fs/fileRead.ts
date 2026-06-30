import { readFile } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'

/** Hard cap on bytes returned from a read, so huge files can't blow up the model context. */
export const MAX_READ_BYTES = 256 * 1024
/** Default first-pass file window. The model can request an explicit range or full read. */
export const DEFAULT_READ_LINES = 120
/** Files at or below this size are cheaper to read once than to force another range call. */
export const SMALL_FILE_FULL_LINES = 220

export interface ReadResult {
  path: string
  content: string
  truncated: boolean
  totalLines: number | null
  startLine: number
  endLine: number
  defaultWindow: boolean
}

export interface ReadLineRangeOptions {
  countTotalLines?: boolean
  defaultWindow?: boolean
}

/**
 * Stream a 1-based inclusive line range from `abs` without buffering the
 * whole file. We stop early on `MAX_READ_BYTES` so a runaway file (logs,
 * minified bundles) can't blow the model context. When the caller only needs
 * a bounded range, `countTotalLines: false` lets us stop once the requested
 * window is satisfied instead of scanning the rest of the file.
 */
export async function readLineRange(
  abs: string,
  startLine?: number,
  endLine?: number,
  options: ReadLineRangeOptions = {}
): Promise<ReadResult> {
  const s = Math.max(1, startLine ?? 1)
  const e = Math.max(s, endLine ?? Number.MAX_SAFE_INTEGER)
  const countTotalLines = options.countTotalLines ?? false
  const lines: string[] = []
  let bytes = 0
  let totalLines = 0
  let truncated = false
  let totalLinesKnown = true
  const stream = createReadStream(abs, { encoding: 'utf8' })
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    totalLines += 1
    if (totalLines < s) continue
    if (totalLines > e) {
      if (!countTotalLines) {
        totalLinesKnown = false
        rl.close()
        stream.destroy()
        break
      }
      continue
    }
    const nextBytes = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + nextBytes > MAX_READ_BYTES) {
      truncated = true
      break
    }
    bytes += nextBytes
    lines.push(line)
  }
  return {
    path: abs,
    content: lines.join('\n'),
    truncated,
    totalLines: totalLinesKnown ? totalLines : null,
    startLine: s,
    endLine: Math.min(e, Math.max(s, totalLines)),
    defaultWindow: options.defaultWindow ?? false
  }
}

/**
 * Whole-file UTF-8 read with a hard byte ceiling. Used by the explicit
 * `full=true` path so the agent can ask for an entire file when it knows it
 * needs everything; range reads should prefer `readLineRange` for memory.
 */
export async function readFileBounded(abs: string): Promise<ReadResult> {
  const buf = await readFile(abs)
  let truncated = false
  let text: string
  if (buf.byteLength > MAX_READ_BYTES) {
    text = buf.subarray(0, MAX_READ_BYTES).toString('utf8')
    truncated = true
  } else {
    text = buf.toString('utf8')
  }
  const lines = text.split('\n')
  const totalLines = lines.length
  return {
    path: abs,
    content: text,
    truncated,
    totalLines,
    startLine: 1,
    endLine: totalLines,
    defaultWindow: false
  }
}
