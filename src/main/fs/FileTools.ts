import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { countOccurrences, diffSummary, type DiffSummary } from './fileDiff'
import {
  DEFAULT_READ_LINES,
  SMALL_FILE_FULL_LINES,
  readFileBounded,
  readLineRange,
  type ReadResult
} from './fileRead'
import {
  DEFAULT_SEARCH_CONTEXT_LINES,
  MAX_SEARCH_CONTEXT_LINES,
  MAX_SEARCH_RESULTS,
  searchWithRipgrep,
  type SearchHit,
  type SearchResult
} from './fileSearch'

/**
 * Raw filesystem operations the agent can drive. Whole-filesystem scope —
 * any path the OS user can reach — so every method resolves the path to an
 * absolute one and operates directly. Writes are auto-applied (create /
 * overwrite / edit happen immediately); the caller surfaces what changed.
 *
 * Helpers split into siblings:
 *   • `fileRead.ts`   — bounded byte/line reads
 *   • `fileDiff.ts`   — cheap line-level diff + occurrence counting
 *   • `fileSearch.ts` — ripgrep wrapper with content + path lanes and ranking
 *
 * All methods throw on failure with a human-readable message; the tool
 * dispatch layer turns that into a structured tool_result.
 */

const MAX_DIR_ENTRIES = 1000

interface WriteResult {
  path: string
  created: boolean
  bytes: number
  diff: DiffSummary
}

interface EditResult {
  path: string
  replacements: number
  diff: DiffSummary
}

interface DirEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  size: number
}

export class FileTools {
  /**
   * Root that represents the user-chosen working folder.
   * Absolute paths still work anywhere the OS user can reach.
   */
  private root: string | null = null

  /** Repoint the working folder. Pass null to clear it (cwd-relative again). */
  setRoot(root: string | null): void {
    this.root = root?.trim() || null
  }

  /** The current working folder, or null when none is pinned. */
  getRoot(): string | null {
    return this.root
  }

  /** Resolve a caller-supplied path against the workspace root (or cwd). */
  private resolve(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.root ?? process.cwd(), path)
  }

  /** Read a UTF-8 file, optionally a 1-based inclusive line range. */
  async read(
    path: string,
    startLine?: number,
    endLine?: number,
    full = false
  ): Promise<ReadResult> {
    const abs = this.resolve(path)
    if (startLine != null || endLine != null) return readLineRange(abs, startLine, endLine)
    if (!full) {
      const preview = await readLineRange(abs, 1, SMALL_FILE_FULL_LINES, true)
      // Small files come back whole — no point making a second tool call
      // when we already paid for the I/O. Larger files truncate to
      // DEFAULT_READ_LINES and signal `defaultWindow: true` so the agent
      // knows to ask for more.
      if (preview.totalLines <= SMALL_FILE_FULL_LINES) {
        return { ...preview, endLine: preview.totalLines, defaultWindow: false }
      }
      const previewLines = preview.content.split('\n').slice(0, DEFAULT_READ_LINES)
      return {
        ...preview,
        content: previewLines.join('\n'),
        endLine: DEFAULT_READ_LINES,
        defaultWindow: true
      }
    }
    return readFileBounded(abs)
  }

  /** Create or overwrite a file (parent dirs created as needed). */
  async write(path: string, content: string): Promise<WriteResult> {
    const abs = this.resolve(path)
    const prior = await this.tryReadString(abs)
    const created = prior == null
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return {
      path: abs,
      created,
      bytes: Buffer.byteLength(content, 'utf8'),
      diff: diffSummary(prior ?? '', content)
    }
  }

  /**
   * Exact string replacement inside an existing file. By default the match
   * must be unique (replaceAll=false → exactly one occurrence), mirroring a
   * surgical edit; replaceAll replaces every occurrence.
   */
  async edit(
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<EditResult> {
    const abs = this.resolve(path)
    const prior = await this.tryReadString(abs)
    if (prior == null) throw new Error(`File does not exist: ${abs}`)
    if (oldString === newString) {
      // Identical strings can't change anything. Return a no-op result so the
      // caller (and the agent) can move on instead of swallowing a throw and
      // forcing a retry. The tool wrapper in fsTools.ts surfaces this case
      // earlier with a more actionable message; this branch keeps direct
      // FileTools consumers safe.
      return { path: abs, replacements: 0, diff: diffSummary(prior, prior) }
    }

    const occurrences = countOccurrences(prior, oldString)
    if (occurrences === 0) throw new Error('oldString not found in file')
    if (!replaceAll && occurrences > 1) {
      throw new Error(
        `oldString is not unique (${occurrences} matches). Add surrounding context or set replaceAll.`
      )
    }
    const next = replaceAll
      ? prior.split(oldString).join(newString)
      : prior.replace(oldString, newString)

    await writeFile(abs, next, 'utf8')
    return {
      path: abs,
      replacements: replaceAll ? occurrences : 1,
      diff: diffSummary(prior, next)
    }
  }

  /** List a directory's immediate entries (sorted dirs-first then name). */
  async list(path: string): Promise<{ path: string; entries: DirEntry[]; truncated: boolean }> {
    const abs = this.resolve(path)
    const names = await readdir(abs)
    const namesToStat = names.slice(0, MAX_DIR_ENTRIES)
    const statJobs: Promise<DirEntry>[] = namesToStat.map(async (name): Promise<DirEntry> => {
      const fullPath = join(abs, name)
      try {
        const st = await stat(fullPath)
        return {
          name,
          type: (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other') as 'dir' | 'file' | 'other',
          size: st.isFile() ? st.size : 0
        }
      } catch {
        return { name, type: 'other' as 'dir' | 'file' | 'other', size: 0 }
      }
    })
    const entries = await Promise.all(statJobs)
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    )
    return { path: abs, entries, truncated: names.length > MAX_DIR_ENTRIES }
  }

  /**
   * Search source files by content and, for fixed-string queries, by file
   * path/name in parallel. Lowercase queries stay broad; queries containing
   * uppercase letters become case-sensitive for better symbol precision.
   * `glob` restricts which file names are scanned (a simple * / ? glob, no
   * path separators). Bounded by MAX_SEARCH_RESULTS hits and a directory-
   * skip list for the usual heavy dirs.
   */
  async search(
    query: string,
    path = '.',
    glob?: string,
    contextLines = DEFAULT_SEARCH_CONTEXT_LINES,
    maxResults = MAX_SEARCH_RESULTS,
    regex = false
  ): Promise<SearchResult> {
    const root = this.resolve(path)
    if (!query.trim()) return { root, hits: [], truncated: false }
    const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(maxResults) || MAX_SEARCH_RESULTS))
    const context = Math.max(0, Math.min(MAX_SEARCH_CONTEXT_LINES, Math.floor(contextLines) || 0))
    return searchWithRipgrep(root, query, glob, context, limit, regex)
  }

  /**
   * For a path that doesn't exist, list same-directory entries whose name is
   * a near miss (shared stem or basename substring) — so a wrong-filename
   * guess (vite.config.ts → electron.vite.config.ts) becomes self-correcting
   * in one step instead of needing a separate list_dir.
   */
  async nearbyMatches(path: string, max = 6): Promise<string[]> {
    const abs = this.resolve(path)
    const dir = dirname(abs)
    const want = basename(abs).toLowerCase()
    const wantStem = want.replace(/\.[^.]+$/, '')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    return names
      .filter((name) => {
        const n = name.toLowerCase()
        const stem = n.replace(/\.[^.]+$/, '')
        return n.includes(wantStem) || wantStem.includes(stem) || n.includes(want) || want.includes(n)
      })
      .slice(0, max)
  }

  private async tryReadString(abs: string): Promise<string | null> {
    try {
      return await readFile(abs, 'utf8')
    } catch {
      return null
    }
  }
}

export type { SearchHit, SearchResult, ReadResult, DirEntry, WriteResult, EditResult, DiffSummary }
