# navigate: DOM-order wireframe + capture-to-disk

## Why (proven from a real HN run)

The a11y-tree wireframe FAILED on HN: 52 empty `row` nodes, footer links at
`@a1`, real stories crowded out by the 60-node cap. Meanwhile `grep_page` read
the page PERFECTLY in document order ("1. Claude Sonnet 5 … 482 comments"). The
a11y tree is the wrong source for table-heavy pages; the DOM is the truth.

Gladdis already has the right tool: `PageExtractor.run()` → `PageCapture`
(`shared/extraction.ts`). Its `actions: ActionNode[]` is "Interactive action
surface, ordered by DOM position" — real names, hrefs, selectors, coords. Its
`content: ReadableContent` is cleaned title/headings/text/markdown. This is what
`read_page` already uses. The wireframe must come from HERE, not the a11y tree.

## The contract

On a settling navigate, in addition to the existing brief (effective URL,
readyState, size):

1. **Capture once** via `PageExtractor.run(tabId)` → `PageCapture` (DOM-order,
   cleaned, real names).
2. **Write the whole cleaned page to disk** (per-conversation scratch dir):
   - `<slug>.md` — readable content: `# title`, byline, heading outline, main
     text/markdown in document order.
   - `<slug>.actions.json` — the DOM-order `ActionNode[]`: `{idx, role, name,
     value(href), selector, rect, inViewport}`.
3. **Return a compact document-order wireframe** built from `actions` (real
   names now — `link "Claude Sonnet 5"`, `link "482 comments"`), collapsing
   repetitive same-role runs IN PLACE, PLUS the two file paths so the model can
   read/grep the full page locally with no re-fetch.

### navigate result (text)
```
Navigated to https://news.ycombinator.com/ — complete. ~4k chars.
Saved: pages/news-ycombinator-com.md · pages/news-ycombinator-com.actions.json
WIREFRAME (document order — "top" = first):
  1. link "Claude Sonnet 5" → anthropic.com
     849 points · marinesebastian · 482 comments   [act idx 3 / selector …]
  2. link "Claude Code is steganographically marking requests"
     1377 points · 392 comments
  …
  [footer: Guidelines · FAQ · Lists · API · Security · Legal]
```
(Exact rendering TBD in build; principle: real names, document order, story rows
grouped with their metadata, footer nav collapsed.)

## Disk: location + lifecycle (decided)

- **Dir:** `<userData>/gladdis-pages/<conversationId>/` (per-session scratch).
- **Auto-prune:** bound by page count / total bytes per conversation; evict
  oldest. Clear on conversation end. Ephemeral working data, not an archive.
- **Slug:** from URL host+path, filesystem-safe, deduped.

## Build order (verifiable layers)

1. **PageCapture → wireframe builder** (`buildWireframe` rewritten to take a
   PageCapture's `actions` + `content`, document order, in-place run collapse).
   Pure function, unit-tested against a realistic HN-shaped PageCapture.
2. **Disk writer** — a small module: write `<slug>.md` + `<slug>.actions.json`
   under the per-conversation dir; prune. Unit-tested with a temp dir.
3. **Wire into navigate** — capture via PageExtractor, write, build wireframe,
   return paths. Reuses existing extractor (no parallel machinery).
4. **navigate ToolDef** — description + outputSchema updated (files + wireframe).
5. **read_a11y stays** as-is for control-heavy component UIs (its real use); it
   is NOT the navigate source anymore.
6. Tests + typecheck + build green.

## Explicitly
- **Source of orientation = DOM (PageExtractor), not the a11y tree.** The a11y
  wireframe path built earlier this session is replaced.
- **grep_page unchanged** (it works; the model uses it well).
- **No act/click changes.**
- Reuse `PageExtractor` — do NOT write a second in-page extractor.

## Open (confirm during build if they arise)
- Exact wireframe rendering of a "story row" (title + metadata grouping).
- Prune thresholds (N pages / M MB per conversation).
- Whether to also expose the saved paths in structuredContent (yes) and as a
  one-line hint in text (yes).
