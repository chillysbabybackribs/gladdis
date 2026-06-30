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
  `read_page`, `grep_page`. `screenshot`/`screenshot_app` exist but are a
  **fallback** — the docstring says "Prefer read_page for understanding."
- **DRIVE** (`models/agentTools/drive.ts`, impl in `models/tools/driveTools.ts`):
  `navigate`, `grep_click`, `grep_type`, `click_xy`, `type_text`, `press_key`,
  `execute_in_browser`, `cdp_command`.

### Perception is grep, not vision — this is the core design bet

`grep_page` runs a JS payload **inside the live page** and returns matched
elements with a stable CSS `selector`, visibility, and **live bounding-box
`coordinates`** (center x/y + width/height/top/left, from
`getBoundingClientRect`). Selector/XPath matches include element identity such as
`tagName`, `outerHTML`, and `innerText`; text/regex matches return grep-style
line context around the text hit. `grep_page` has two explicit uses: page-text
search with `type: "text"`/`type: "regex"`, or DOM target lookup with
`type: "selector"` for CSS selectors and XPath. The model asks for exactly the
element it needs and gets that and nothing more.

`grep_click` / `grep_type` are the **same engine one step further**: they run
the same in-page grep (`executeGrepInTab`), filter to `visible && coordinates`,
take the best match, and dispatch a trusted action at those live coordinates.
Discovery and action are one primitive.

This is why screenshots/vision are nearly irrelevant here: for "what is this
element and where exactly is it," the grep result is *more* precise than a
screenshot (literal node + literal coordinate vs. pixels the model must infer
from). The only thing it gives up is genuinely vision-only content (canvas,
unlabeled image-buttons with no text/selector hook) — which is what the
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
- Treating `screenshot` as the perception path. It's the fallback; `grep_page`
  is the path.

## Build / run

`npm run dev` (electron-vite + HMR), `npm run build`, `npm start`.
Other scripts: `check`, `check:size`, `test`, `typecheck`.
