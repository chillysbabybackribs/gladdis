# CLAUDE.md

Orientation for anyone (human or model) reading this codebase. Read this BEFORE
trusting the README, the top-of-file docstrings, or any "overview" you were
handed — several of those describe earlier architectural epochs and will mislead
you. When this file and a docstring disagree, trust the live code, then fix
whichever one is stale.

## What Gladdis is, right now

An Electron 42 + React 19 + TypeScript desktop app: chat on the left, a real
multi-tab Chromium browser (native `WebContentsView` + CDP) on the right. The
same surface has local filesystem and shell access.

## How the model drives the browser (the live path)

The current architecture is an **LLM agent-in-the-loop**, not a deterministic
pipeline (see the caveat on `pipeline/` below). The shared provider loop
(`models/agentLoopRunner.ts -> runProviderAgenticTurn`) is used by the four API
providers (`models/providers/{anthropic,google,openai,grok}.ts`). The two
embedded agent runtimes, **Codex** (`models/codex/`) and **Claude Code**
(`models/claudeCode/`), have their own handoff/server paths.

All of these runtimes ultimately drive the browser through `BrowserTools.run(...)`,
but they do not expose that path the same way: API providers receive direct tool
definitions inside the provider loop, Codex receives dynamic `gladdis.*` tool
calls, and Claude Code receives a local HTTP MCP bridge.

The tools come in two families:

- **PERCEIVE** (`models/agentTools/perceive.ts`, impl in `models/tools/perceiveTools.ts`):
  `grep_page`, `read_a11y`, `read_page`. `screenshot`/`screenshot_app` exist but are a
  **fallback** — for understanding, prefer grep or the accessibility tree over pixels.
- **DRIVE** (`models/agentTools/drive.ts`, impl in `models/tools/driveTools.ts`):
  `navigate`, `grep_click`, `grep_type`, `click_xy`, `type_text`, `press_key`,
  `execute_in_browser`, `cdp_command`.

### Perception is grep + accessibility, not vision — this is the core design bet

`grep_page` runs a JS payload **inside the live page** and returns matched
elements with a stable CSS `selector`, visibility, and **live bounding-box
`coordinates`** (center x/y + width/height/top/left, from
`getBoundingClientRect`). Selector/XPath matches include element identity such as
`tagName`, `outerHTML`, and `innerText`; text/regex matches return grep-style
line context around the text hit. `grep_page` has two explicit uses: page-text
search with `type: "text"`/`type: "regex"`, or DOM target lookup with
`type: "selector"` for CSS selectors and XPath. The model asks for exactly the
element it needs and gets that and nothing more.

`read_a11y` (`src/main/extract/axTree.ts`) captures the live CDP accessibility
tree (`Accessibility.getFullAXTree`, multi-frame), flattens it to a compact
digest, and assigns stable `@a1`/`@a2` refs with role, name, state, and
coordinates (via `DOM.getBoxModel` when available). Use it on component-heavy
UIs where grep text is sparse but controls have accessible names. After
`read_a11y`, pass `@aN` refs to `grep_click`, `grep_type`, or `click_xy`
(`ref` arg); refs are cached per tab and invalidated on navigation.

`read_page` (`PageExtractor`) returns a bounded structural digest + ACTIONS table
— good for orientation, not primary targeting.

`grep_click` / `grep_type` are the **same grep engine one step further**: they run
the same in-page grep (`executeGrepInTab`), filter to `visible && coordinates`,
take the best match, and dispatch a trusted action at those live coordinates.
With `type: "ref"` or a bare `@aN` query they resolve against the latest
`read_a11y` snapshot instead. Discovery and action are one primitive.

This is why screenshots/vision are nearly irrelevant here: for "what is this
element and where exactly is it," grep and a11y results are *more* precise than a
screenshot (literal node + literal coordinate vs. pixels the model must infer
from). The only thing they give up is genuinely vision-only content (canvas,
unlabeled image-buttons with no text/selector/a11y hook) — which is what the
screenshot fallback is for.

## `pipeline/` — read this before you assume it's central OR dead

`src/main/pipeline/` (Planner / Runner / orchestrate) is an older
**deterministic** "plan-once, execute-blind, verify-with-CDP" engine.
`PageExtractor` lives outside that folder in `src/main/extract/PageExtractor.ts`.
Two things mislead readers about it:

1. **It looks central but mostly isn't.** A dozen core files `import` from
   `pipeline/Planner` — but **only the `LlmComplete` *type***, which happens to
   be declared there. The sole file that calls real pipeline *code* is
   `models/tools/taskTools.ts` (it calls `orchestrate` + `generatePipelineFinalResponse`).
   So the perceive/drive path above does NOT run the planner/runner.
   (`PageExtractor` is the exception — the live perceive tools do use it.)
2. **Its docstrings narrate it as the current design** ("the ONE expensive call
   in the whole pipeline", "mirrors the old pre-CDP pipeline"). That framing is
   from when it was the main path. It no longer is.

**Status: undecided.** It is built and still reachable via one task tool, but
whether it gets revived, kept as-is, or retired has NOT been decided. Do not
relabel it "dormant"/"dead" or delete it on your own initiative, and do not
treat it as the main browser-automation path either. If you need to know whether
it's live for a given feature, check whether that feature routes through
`taskTools.orchestrate`.

## Common ways models trip here (avoid these)

- Trusting a confident top-of-file docstring over the live code. Several
  docstrings are frozen at an earlier epoch. Verify against the implementation.
- Concluding `pipeline/` is load-bearing because 12 files import from it — they
  import a *type*, not the pipeline.
- Reading tool *schemas/descriptions* and inferring behavior, instead of reading
  the *handlers* in `models/tools/`.
- Treating `screenshot` as the perception path. It's the fallback; `grep_page` and
  `read_a11y` are the paths.

## Build / run

`npm run dev` (electron-vite + HMR), `npm run build`, `npm start`.
Other scripts: `check`, `check:size`, `test`, `typecheck`.
