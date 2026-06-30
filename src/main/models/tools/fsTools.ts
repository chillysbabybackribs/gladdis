import type { FileTools } from '../../fs/FileTools'
import type { ToolOutcome } from '../browserTools'
import { cap, optNum } from './toolUtils'

export interface FsToolsDeps {
  files: FileTools
}

export async function runReadFile(deps: FsToolsDeps, args: Record<string, any>): Promise<ToolOutcome> {
  const path = String(args.path ?? '')
  let r
  try {
    r = await deps.files.read(path, optNum(args.start_line), optNum(args.end_line), args.full === true)
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    if (/ENOENT|no such file/i.test(msg)) {
      const near = await deps.files.nearbyMatches(path)
      const hint = near.length
        ? ` Did you mean one of: ${near.join(', ')}? Read one of those, or call list_dir on the folder.`
        : ' Call list_dir on the parent folder to see what exists.'
      return { ok: false, text: `read_file: "${path}" does not exist.${hint}` }
    }
    throw err
  }
  const window =
    r.defaultWindow
      ? `showing lines ${r.startLine}-${r.endLine} of ${r.totalLines}; default window`
      : `showing lines ${r.startLine}-${r.endLine} of ${r.totalLines}`
  const next =
    r.defaultWindow && r.totalLines > r.endLine
      ? `\nPrefer search_repo/search_files or read_spans before reading more. Next narrow range: read_file({"path":${JSON.stringify(r.path)},"start_line":${r.endLine + 1},"end_line":${Math.min(r.endLine + 120, r.totalLines)}}). Use full:true only when the whole file is genuinely needed.`
      : ''
  const header = `${r.path} — ${window}${r.truncated ? ' (truncated)' : ''}${next}`
  return { ok: true, text: cap(`${header}\n\n${r.content}`, 30_000) }
}

export async function runWriteFile(deps: FsToolsDeps, args: Record<string, any>): Promise<ToolOutcome> {
  const r = await deps.files.write(String(args.path ?? ''), String(args.content ?? ''))
  return {
    ok: true,
    text: `${r.created ? 'Created' : 'Overwrote'} ${r.path} (${r.bytes} bytes; +${r.diff.added} -${r.diff.removed})`
  }
}

export async function runEditFile(deps: FsToolsDeps, args: Record<string, any>): Promise<ToolOutcome> {
  const path = String(args.path ?? '')
  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  // Guard the two malformed-edit cases that the model produces most often.
  // Surface a clear, actionable result instead of throwing so the loop
  // doesn't burn turns retrying a no-op edit (and the validation supervisor
  // doesn't treat a failed edit as if real content changed).
  if (!path) {
    return { ok: false, text: 'edit_file: "path" is required.' }
  }
  if (!oldString) {
    return {
      ok: false,
      text:
        'edit_file: old_string is empty. Provide the exact text to replace, ' +
        'or call write_file if you mean to create / overwrite the whole file.'
    }
  }
  if (oldString === newString) {
    return {
      ok: false,
      text:
        `edit_file: old_string equals new_string for ${path} — nothing to change. ` +
        'If the file already contains the desired content, skip this edit and move on; ' +
        'otherwise correct new_string and call edit_file again.'
    }
  }
  try {
    const r = await deps.files.edit(path, oldString, newString, args.replace_all === true)
    return {
      ok: true,
      text: `Edited ${r.path} — ${r.replacements} replacement(s); +${r.diff.added} -${r.diff.removed}\n${r.diff.preview}`
    }
  } catch (err) {
    return {
      ok: false,
      text: `edit_file failed: ${(err as Error)?.message ?? String(err)}`
    }
  }
}

export async function runListDir(deps: FsToolsDeps, args: Record<string, any>): Promise<ToolOutcome> {
  const r = await deps.files.list(String(args.path ?? '.'))
  const body = r.entries
    .map((e) => `${e.type === 'dir' ? 'd' : '-'} ${e.name}${e.type === 'file' ? ` (${e.size}b)` : ''}`)
    .join('\n')
  return { ok: true, text: cap(`${r.path}${r.truncated ? ' (truncated)' : ''}\n${body}`) }
}

export async function runSearchFiles(deps: FsToolsDeps, args: Record<string, any>): Promise<ToolOutcome> {
  const search = searchQueryArgs(args)
  const r = await deps.files.search(
    search.query,
    args.path ? String(args.path) : '.',
    args.glob ? String(args.glob) : undefined,
    optNum(args.context_lines) ?? undefined,
    optNum(args.max_results) ?? undefined,
    search.regex
  )
  // Render only the top-ranked hits in full. A broad query can return dozens of
  // hits, each carrying a snippet + read_file suggestion — rendering all of them is
  // the single fattest item a search-heavy turn drops into the model's context. Hits
  // are already score-ranked, so the top slice is the useful part; the rest are
  // reported as a count so the model narrows its query instead of assuming it saw all.
  const RENDERED_HITS = 15
  const shown = r.hits.slice(0, RENDERED_HITS)
  const body = shown.map((h) => {
    if (h.kind === 'path') {
      return (
        `${h.path} [path hit]\n` +
        `read_file({"path":${JSON.stringify(h.path)}})\n` +
        h.snippet
      )
    }
    return (
      `${h.path}:${h.line}: ${h.text}\n` +
      `read_file({"path":${JSON.stringify(h.path)},"start_line":${h.startLine},"end_line":${h.endLine}})\n` +
      h.snippet
    )
  }).join('\n\n')
  const overflow = r.hits.length - shown.length
  const header =
    `${r.hits.length} hit(s)${r.truncated ? ' (truncated)' : ''}` +
    (overflow > 0 ? ` — showing top ${shown.length}; narrow the query to see the other ${overflow}` : '')
  return {
    ok: true,
    text: cap(`${header}\n${body}`)
  }
}

/**
 * Resolve the agent-supplied search query into ripgrep input. Supports:
 *  • leading/trailing `*foo*` wildcards (just stripped — ripgrep's default
 *    matching is already substring-y)
 *  • `term1|term2` shorthand to OR multiple terms (escaped, then re-joined as
 *    a regex alternation)
 *  • explicit `regex: true` to skip escaping entirely
 */
export function searchQueryArgs(args: Record<string, any>): { query: string; regex: boolean } {
  const raw = args.query ?? args.pattern ?? args.text ?? args.term ?? ''
  let query = String(raw).trim()
  if (!query) return { query: '', regex: args.regex === true }

  const wildcardWrapped = query.match(/^\*([^*].*?)\*$/)
  if (wildcardWrapped) query = wildcardWrapped[1].trim()

  if (args.regex === true) return { query, regex: true }
  if (!query.includes('|')) return { query, regex: false }

  const terms = query
    .split('|')
    .map((term) => term.trim())
    .filter(Boolean)
  if (terms.length <= 1) return { query, regex: false }

  return {
    query: terms.map(escapeRegExp).join('|'),
    regex: true
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
