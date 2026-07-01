# Agent Toolset — Target Spec

A greenfield specification for the tool surface of an LLM agent that drives a
browser (plus local files/shell). Implementation-agnostic. This is the North
Star; the current code is migrated toward it, not the other way around.

---

## 0. The one principle everything derives from

> **Optimize for grounding, not turn count.** The agent must act on a belief
> about the page/filesystem that is identical to its actual state at the instant
> of action.

Almost every real agent failure — wrong element, stale layout, infinite loop —
is a *grounding* failure, not a latency failure. Therefore:

- A design that does fewer turns but acts on staler state is **worse**.
- "Continuous perception" (auto-pushing DOM/state into context every step) is
  **rejected**: it pollutes attention, goes stale the instant the model thinks,
  and discards the model's intent signal. Perception is **pull-based and
  freshly sampled**.
- "Semantic/embedding element selection" as a primary path is **rejected**: it
  replaces an exact, deterministic node+coordinate lookup with a lossy
  inference. Structured introspection is more precise than vision here. Vision
  is a **narrow declared fallback**, never the default.

Speed is recovered two ways that don't hurt grounding:
1. **Fusion** — every Action returns a fresh post-action observation in the same
   call, so re-grounding never costs a separate turn.
2. **Lazy freshness** — pull exactly the slice needed, exactly when needed, so
   you never re-ground state that didn't change.

Grounding is also a **completion** discipline, not just a perception one. The
symmetric failure at the end of a task is **proxy substitution**: accepting an
aggregate or summary *about* the target as if it were the target. A floor/"from"
price is not a bookable itinerary; "the build usually passes" is not a passing
build; a count of matches is not the matched record. When a done-check names a
specific concrete object, a statistic that merely describes or bounds that object
does **not** satisfy it — the check is *not met*, not met-with-a-caveat. The
grounding rule "act on state identical to the actual state" applies to the claim
of doneness exactly as it applies to the act: verify the concrete object, don't
infer it from a summary. A corollary: if the agent can *name* the action that
would produce the concrete object (drive the UI instead of reading a summary
page, try specific inputs), that named step is the next action, not a stopping
point.

---

## 1. The two hard axes

Every tool sits at exactly one position on each axis. No tool spans two; no gap
is left uncovered.

| Axis | Pole A | Pole B |
|---|---|---|
| **Effect** | Perception (read-only, idempotent, no side effects) | Action (state-changing, trusted input) |
| **Altitude** | Intent / high-level (resolves "what I mean") | Primitive / escape hatch (raw machine access) |

A tool that is "Perception + Intent" (e.g. `outline`) must never mutate. A tool
that is "Action + Intent" (e.g. `act`) must always re-perceive. The escape hatch
(`cdp`) is the only tool allowed to be altitude-Primitive and effect-either.

---

## 2. Browser tool surface

### 2.1 Perception (pull-based, fresh every call, side-effect-free)

#### `query`
Exact targeting **and** page-content search. The scalpel.

```
query(page, {
  q: string,                       // text, regex, CSS selector, or XPath
  mode: "text"|"regex"|"selector", // default "text"
  context_lines?: number,          // for text/regex: grep-style surrounding lines
  case_sensitive?: boolean
}) -> {
  matches: Array<{
    kind: "text"|"node",
    // for text/regex hits:
    matched_line?: string, context?: string,
    // for node hits (selector, or text resolved to an element):
    role?: string, name?: string, value?: string, states?: string[],
    selector?: string, tag?: string,
    visible: boolean,
    box?: { x, y, width, height, top, left }   // live getBoundingClientRect
  }>,
  total: number, truncated: boolean
}
```

Contract:
- Runs **inside the live page** at call time. Coordinates are real, not cached.
- Returns the literal node + literal coordinate — no inference.
- Two intents: page-text Q&A (`text`/`regex`) and DOM targeting (`selector`).
- MUST refuse/penalize broad selectors (`a`, `div`, `*`) that dump the page.

#### `outline`
Orientation. The compact cached semantic map. **A distinct perception MODE from
`query`** — orientation vs. targeting — not redundant with it.

```
outline(page, {
  focus?: string,           // rank relevant regions higher
  viewport_only?: boolean,
  interactive_only?: boolean // default true; landmarks + controls
}) -> {
  url, title,
  nodes: Array<{
    ref: string,            // stable @r1/@r2… valid until navigation
    role, name, value?, states[],
    in_viewport: boolean,
    box?: { x, y, width, height, top, left }
  }>,
  truncated: boolean
}
```

Contract:
- Cached read-through (short TTL, invalidated on navigation). Cheap to repeat.
- `ref`s are the handoff currency: pass `@rN` to `act`.
- Built from the accessibility tree (multi-frame), not pixels.

#### `observe_network`
Read the JSON the page is built from, not the rendered HTML.

```
observe_network(page, {
  mode: "next_action"|"passive",   // default next_action: arm the next Action
  url_filter?|url_regex?, resource_types?, status_range?, mime_includes?,
  window_ms?, max_bodies?, max_body_chars?
}) -> {
  captured: Array<{ url, method, status, mime, timing, body? }>,
  total_seen: number
}
```

Contract:
- `next_action` arms capture *before* the page changes (the correct default —
  you watch before you trigger).
- For data-heavy pages, one captured API response replaces N scroll-and-read
  cycles and returns complete, un-paginated data.

### 2.2 Action (fused find→act→re-observe; ALWAYS returns fresh state)

#### `act`
The single trusted-input verb. Intent on the outside, exact coordinate on the
inside. **This is the most important tool in the spec** — fusing discovery,
action, and re-perception into one call is what eliminates the staleness window
between "find" and "do."

```
act(page, {
  kind: "click"|"type"|"key"|"select",
  // target — exactly one resolution path:
  ref?: string,        // @rN from outline (preferred)
  query?: string,      // resolve via the query engine (text/selector/regex)
  coords?: { x, y },   // last resort, explicit
  // payload by kind:
  text?: string,       // for type
  key?: string,        // for key: Enter, Tab, Escape, Arrow*, …
  option?: string      // for select
}) -> {
  ok: boolean,
  resolved: { ref?, role?, name?, box },   // what was actually acted on
  // FRESH post-action observation, bundled — no separate perception turn:
  after: { url, title, digest, changed_region?: outline-slice }
}
```

Contract:
- Dispatches **trusted OS-level input events** (real mouse/keyboard via the
  debugger), never synthetic JS `.click()` — so the page can't tell it's a bot
  and event handlers fire correctly.
- Target resolution order: `ref` > `query` > `coords`. Resolves against the
  **current** live page; if the `ref`/`query` no longer resolves, returns
  `ok:false` with a re-orient hint rather than clicking the wrong thing.
- The `after` field is mandatory. Every state change re-grounds the model for
  free.

#### `navigate`
The one clean single-purpose state transition.

```
navigate(page, { url, wait?: boolean, timeout_ms? })
  -> { url, final_url, settle: "load"|"timeout", page_size_chars }
```

Contract:
- Reports page size so the next `query` can be sized (heavy page → distinctive
  multi-word queries).
- Like `act`, it is an Action: callers re-perceive after (or read the bundled
  size hint).

### 2.3 Escape hatch (the "glass" — non-negotiable)

#### `cdp`
Raw protocol. The safety valve. A toolset without this is a toy.

```
cdp({ method: string, params?: object }) -> { result }
```

#### `eval`
Scoped page JS, one notch above raw CDP for convenience.

```
eval(page, { js: string }) -> { result }   // `return <expr>` to yield a value
```

Contract:
- These bound nothing and express anything: network interception, emulation,
  exotic input, DOM mutation, scalar reads.
- They are the *flexibility* answer. They are NOT the default — reaching for
  `eval`/`cdp` when `query`/`act` would do is a smell.

### 2.4 Vision fallback (declared last resort)

#### `screenshot`
```
screenshot(page, { full_page?: boolean }) -> { image }
```

Contract:
- Exists **only** for genuinely vision-only targets: canvas, unlabeled
  icon-buttons with no accessible name, visual-rendering confirmation.
- Pixels are the worst grounding source (model infers coordinates). Using
  `screenshot` where `query`/`outline` would answer is an explicit anti-pattern.
- Documented as a fallback in the tool description itself, so the model is
  steered away from it by default.

### Browser surface summary

| Domain | Tools | Altitude |
|---|---|---|
| Perception | `query`, `outline`, `observe_network` | intent |
| Action | `act`, `navigate` | intent |
| Escape hatch | `cdp`, `eval` | primitive |
| Vision fallback | `screenshot` | fallback |

**8 browser tools.** The count is incidental — the property that matters is that
each occupies exactly one cell of the Effect × Altitude grid with no overlap and
no gap.

---

## 3. Non-browser surface (same axes applied)

The grounding principle generalizes. Local work gets the same Perception /
Action / Escape-hatch split.

### 3.1 Filesystem

| Domain | Tool | Notes |
|---|---|---|
| Perception | `search_files` | locate before reading; ranked hits + suggested read windows |
| Perception | `read_file` | bounded by default; line-range for surgical reads; dedup re-reads |
| Perception | `list_dir` | immediate entries |
| Action | `edit_file` | exact-string replace (the fused find→edit primitive) |
| Action | `write_file` | create / overwrite |

Mirror of the browser axes: `search_files` is `query`, `read_file`/`list_dir`
are `outline`-like orientation, `edit_file` is `act` (targeted, verifiable),
`write_file` is `navigate` (clean single-purpose state set).

### 3.2 Shell — the local escape hatch

| Domain | Tool | Notes |
|---|---|---|
| Escape hatch | `run_command` | the `cdp`/`eval` of the local machine |

`run_command` is the universal local primitive. It **subsumes** validation
(`typecheck`/`test`/`build`), git publish, dev-server control, and clipboard —
none of those deserve a dedicated tool any more than "click" deserves a tool
separate from `act`. They are commands, not capabilities.

### 3.3 Web search

| Domain | Tool | Notes |
|---|---|---|
| Perception | `search` | SERP + evidence digest; `open_best: true` loads the top hit in the visible tab |

One tool. Reading a known URL = `navigate` + `query`; there is no separate
`fetch_page`. Multi-page "deep research" is a *loop the agent runs*, not a tool.

### 3.4 Memory / continuity

| Domain | Tool | Notes |
|---|---|---|
| Perception/Action | `memory` | single verb, `op: read\|write\|list\|forget\|recall` |
| Perception | `recall_history` | retrieve trimmed/earlier context on demand (pull-based) |

`recall_history` is the continuity expression of the same lazy-freshness rule:
past context is **pulled when referenced**, never auto-injected.

---

## 4. Cross-cutting contracts (the part that actually matters)

These bind every tool above. The tools are only correct if these hold.

### C1 — Action returns fresh perception
Every Action (`act`, `navigate`, `edit_file`, `write_file`) returns enough fresh
state in the same call that the model rarely needs a follow-up Perception call.
This is the turn-reduction mechanism — fusion, not pre-pushing.

### C2 — Perception is pull-based and fresh
No tool auto-streams state into context. The model asks for the slice it needs;
the system samples it live at call time. `outline` may cache with a short TTL,
but cache is invalidated on any navigation/Action.

### C3 — Exact over inferred
Targeting resolves to a literal node + literal coordinate (`query`/`outline`/
`act`). Vision/semantic inference is a declared fallback (`screenshot`) for
vision-only content only.

### C4 — Trusted input
Actions dispatch real OS-level input events, never synthetic JS clicks.

### C5 — Escape hatch always present
`cdp`/`eval` (browser) and `run_command` (local) are always available. They are
the flexibility guarantee; nothing the specialized tools can't express is
unreachable.

### C6 — Stale-ref safety
When a `ref`/`query` no longer resolves against the current live state, the tool
returns `ok:false` with a re-orient hint — it never falls back to acting on a
guess.

### C7 — Anti-dump
Perception tools refuse or penalize queries that would dump the whole page/repo
(broad selectors, bare common words, whole-file reads of large files). The
token savings are a property of the surface, not the model's discipline.

### C8 — Flat surface, no profiles
The set is small enough (~16 tools total) that the whole surface is offered every
turn. No profile-selection, no mid-turn `request_tools` escalation, no
"the model can't do X because its profile lacked the tool" failure class.

---

## 5. Full target surface (one screen)

```
BROWSER
  Perception   query · outline · observe_network
  Action       act · navigate
  Escape       cdp · eval
  Fallback     screenshot

LOCAL
  Perception   search_files · read_file · list_dir
  Action       edit_file · write_file
  Escape       run_command

WEB          search
MEMORY       memory · recall_history
```

~16 tools, every one at a single, non-overlapping altitude, bound by C1–C8.

---

## 6. What this spec explicitly rejects

- **Continuous/push perception** — violates C2; pollutes context, goes stale.
- **Semantic/embedding selection as primary** — violates C3; lossier + slower
  than structured introspection.
- **Separate find / act tools** — reintroduces the staleness window C1 closes.
- **Capability tools that are workflows** (deep-research, audit, repo-dossier,
  verify-change) — those are *loops the agent runs* over primitives, not tools.
- **Dedicated tools for shell-expressible actions** (validate, publish,
  dev-server, clipboard) — they are commands under `run_command`, not
  capabilities.
- **Tool profiles / mid-turn escalation** — unnecessary at this surface size
  (C8); a source of dead-stop bugs.

---

## 7. Relationship to the current code (migration note)

The current surface is close on the local side and on the perception design bet
(grep+a11y over vision). The gaps to close to reach this spec:

1. **Fuse the Action layer** — collapse `click_xy`/`type_text`/`press_key`/
   `grep_click`/`grep_type` into one `act(kind, target)` that returns `after`
   state (C1). This is the biggest and most valuable change.
2. **Restore `outline`** (the orientation mode `read_page` provided) — Phase A
   over-cut it; orientation ≠ targeting.
3. **Keep `screenshot` as a declared fallback**, not delete it (C3 fallback).
4. **Rename to the axes** — `grep_page`→`query`, `read_a11y`→`outline` (or keep
   names, adopt contracts). Names are cosmetic; C1–C8 are not.
5. **Retire profiles + `request_tools`** (C8).
6. **Decide the validation question** — under this spec, edit→validate runs via
   `run_command`, not a dedicated tool.
```
