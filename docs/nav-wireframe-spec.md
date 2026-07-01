# navigate → page wireframe (design spec)

## The inversion being fixed

**Before (wrong):** navigate runs a capture → `scoreNode` heuristics pre-decide
what's "important" → hands the model a re-ordered, ranked list. The model
inherits the system's guess. On HN this ranked the #1 story at @a13 and buried
document order — the one thing that means "top story."

**After (right):** navigate returns a **faithful text wireframe in document
order**. The MODEL reads it against the user's prompt and decides what matters,
because only the model has the prompt. "Top post" = top of the page, 100% of the
time — the page's own order carries the meaning; we stop overwriting it.

## Principles (from the user)

1. **Wireframe sketch in text.** header / sidebar / main / footer as spatial
   regions, spacing preserved, unnecessary info stripped.
2. **Document order, always.** No score reordering. First in the page = first in
   the map. Reverses the session's ranking work (#24/#25 reordering).
3. **Model reasons, doesn't dump-read.** The wireframe is compact orientation;
   the model reads the top sections, then reads deeper ONLY if needed.
4. **No `act`/`click` for now** — the loop is navigate → wireframe → understand →
   grep_page / read a section → answer. Acting is deferred until orientation is
   trustworthy.
5. **"Broad word" → grep with prompt-derived variations**, never the single
   literal word (separate guidance fix).

## What navigate returns

Keep the brief that already works: effective URL (post-redirect), readyState,
page-text size hint. REPLACE the ranked "PRIMARY HANDLES" block with a wireframe:

```
WIREFRAME (document order):
[banner] Hacker News · new · past · comments · ask · show · jobs · submit · login
[main]
  1. Claude Sonnet 5  (anthropic.com)  — 320 pts · 210 comments
  2. From brain waves to words: a new path to communication…  — 180 pts · 95 comments
  3. Hatari – Online Atari ST/STE/TT/Falcon Emulator  — …
  … (28 rows total)
[contentinfo] Guidelines · FAQ · Lists · API · Security · Legal
```

- Regions are landmark roles (`banner`→header, `navigation`→nav, `main`,
  `complementary`→sidebar, `contentinfo`→footer). Fallback to geometry
  (top band / left column / center / bottom) when landmarks are absent.
- Within a region: **interactive + heading + list content in document order**,
  compacted (nav links joined on one line; list items numbered as the page
  numbers them).
- Coordinates are NOT shown inline (they were noise and a false-precision trap).
  They stay in structuredContent for any tool that needs them.
- Repetition still collapses ("… 28 rows total") but by TRUNCATION IN ORDER,
  never by reordering.

## Implementation

1. **Capture: keep landmarks.** Add landmark/heading/list roles to what the a11y
   capture retains (today `interactiveOnly` drops them). Introduce a `structural`
   capture mode that keeps region containers + their ordered leaf content.
2. **Stop sorting.** Remove `scoreNode`-based reordering in `flattenAxNodes` and
   `captureAxSnapshot`. Nodes stay in tree (document) order. `scoreNode` may
   survive ONLY as a noise filter (drop empty/hidden), never as an order key.
3. **New `buildWireframe(snapshot)`** replaces `buildPageMap`: walks nodes in
   order, buckets them into regions, compacts each region to text. Returns both
   the text sketch and a structured region tree.
4. **navigate** returns brief + wireframe text; caches the ordered snapshot so
   any `@ref`/coordinate the model later needs still resolves.
5. **read_a11y** returns document order too (same de-ranking), so the two agree.

## Explicitly reverted / removed

- `scoreNode` as an ORDERING mechanism (the box-area / name-length / fold
  heuristics that outranked the top story). Keep at most a boolean noise filter.
- `buildPageMap`'s "PRIMARY HANDLES ranked" framing.
- The `@a13-was-really-#1` class of bug — impossible once order = document order.

## Open questions to confirm before building

- Wireframe size budget (how many rows per region before truncating)?
- Show per-row metadata (points/comments) or just the title link text?
- Keep `read_a11y`'s coordinate column, or move coords fully to structured only?
```
