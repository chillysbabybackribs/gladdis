# gladdis

A CDP-owned browser + chat desktop app. Cursor-dark themed. Split view:
**chat on the left, a real multi-tab Chromium browser on the right.**

Every tab is a native Electron `WebContentsView` with the Chrome DevTools
Protocol debugger attached, so the entire browser — DOM tree, network,
console, runtime, storage, page lifecycle — is programmatically accessible.
Renderer IPC exposes `window.gladdis.tabs`, `window.gladdis.cdp`, and the
higher-level model tool surface in `src/main/models/browserTools.ts`.

## Stack

- **Electron 42** — stable `WebContentsView` API
- **electron-vite 5** — main / preload / renderer bundling + HMR
- **React 19 + TypeScript** — renderer UI
- **Custom React split layout** — two chat panels around a native browser view

## Run

```bash
npm install
npm run dev      # electron-vite dev with HMR
```

Build / preview a production bundle:

```bash
npm run build
npm start
```

### Linux sandbox note

On many Linux setups Electron's SUID sandbox helper isn't configured and the
app aborts at launch with a `chrome-sandbox ... mode 4755` error. Two options:

- **Proper fix** (recommended), one time:
  ```bash
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  ```
- **Quick/dev workaround:** launch with `--no-sandbox` (weakens isolation).

### Trust local/self-signed HTTPS pages

If the embedded browser shows a "not trusted" certificate warning for your local
dev site, you can allow local HTTPS cert exceptions for testing only:

```bash
export GLADDIS_TRUST_LOCAL_CERTS=1
export GLADDIS_TRUSTED_LOCAL_CERT_HOSTS=localhost,127.0.0.1,::1
# optional: add internal hosts, comma-separated
```

This only applies to HTTPS and only to the listed hosts; everything else still
needs a valid certificate chain. For production-like testing, prefer installing
the certificate into your OS trust store and running with the trust override off.

### OAuth/login pages in embedded webviews

If you see the exact Google-style warning:

> This browser or app may not be secure. Try using a different browser.

that is often provider policy for embedded browsers, not a browser trust error.
Google and some other identity providers intentionally block OAuth from
embedded webviews. In that case the reliable fix is to use an external browser
for sign-in and return to Gladdis after authentication.

## Architecture

```
src/
  main/                 # Electron main process
    index.ts            # BaseWindow + root WebContentsView (the UI), IPC/menu wiring
    TabManager.ts       # owns a WebContentsView per tab, layering, zoom & bounds
    cdp/
      CDPSession.ts      # debugger.attach('1.3'), enables CDP domains, event pump
    extract/
      PageExtractor.ts   # deterministic page capture used by read_page/search tools
    models/
      ChatService.ts     # provider dispatch, agent lifecycle, Codex/Claude Code handoff
      browserTools.ts    # deterministic tool dispatcher used by all agent runtimes
      agentTools/        # tool definitions grouped by search/browser/repo/fs/memory
      codex/             # Codex app-server integration + dynamic gladdis.* tools
      claudeCode/        # Claude Code CLI integration + local HTTP MCP bridge
    fs/                  # file/repo/workspace helpers
    terminal/            # PTY host for the in-app terminal
  preload/
    index.ts            # contextBridge -> window.gladdis API
  renderer/             # React UI (chat panels + browser controls + modals)
    App.tsx             # top-level app shell
    components/         # Workspace, ChatPanel, BrowserPanel, AgentBuilder, terminal
    styles/             # Cursor-dark theme
shared/
  types.ts              # shared barrel for IPC, model, chat, browser, agent types
```

### How the browser is layered

`WebContentsView` is a **native OS layer**, not a DOM element — it renders
*over* the renderer's HTML. So `BrowserPanel` renders an empty `.browser-stage`
div, a `ResizeObserver` reports that div's pixel rect to main, and
`TabManager.setBounds()` positions the active tab's view to fill it exactly.
Switch the split or resize the window and the browser tracks the hole.

### CDP access for models

`CDPSession` attaches the debugger and enables `Page`, `Network`, `DOM`, `CSS`,
`Runtime`, `Log`, `Performance`, `Security`, and `Target` up front, so events
stream automatically. Everything is reachable two ways:

- **Structured** — `window.gladdis.tabs.*` (create / navigate / switch / …)
- **Raw escape hatch** — `window.gladdis.cdp.send({ tabId, method, params })`
  fires *any* CDP command; `window.gladdis.cdp.onEvent(cb)` receives every event.

Example, from the renderer / chat agent:

```ts
const tab = await window.gladdis.tabs.create('https://news.ycombinator.com')
const dom = await window.gladdis.cdp.send({ tabId: tab.id, method: 'DOM.getDocument', params: { depth: -1 } })
const title = await window.gladdis.cdp.send({
  tabId: tab.id,
  method: 'Runtime.evaluate',
  params: { expression: 'document.title', returnByValue: true }
})
```

## Models & chat

The chat panels stream real completions from six provider families:

- Anthropic — via `@anthropic-ai/sdk`
- Google — via `@google/genai`
- OpenAI — via the OpenAI-compatible Responses endpoint wrapper in
  `src/main/models/providers/openai.ts`
- Grok/xAI — via the OpenAI-compatible wrapper in
  `src/main/models/providers/grok.ts`
- Codex — via a local long-lived `codex app-server`
- Claude Code — via the local Claude Code CLI plus a Gladdis MCP bridge

The canonical static model catalog lives in `shared/models.ts`; Codex also adds
live CLI models from `codex app-server model/list` when available.

Completions run in the **main process**, so API keys never reach the renderer —
only streamed text deltas do (over the `chat:stream` IPC channel, keyed by
requestId, with per-request abort). Assistant output renders as sanitized
markdown (`marked` + `DOMPurify`).

### API keys

Set keys via the settings button in the chat header (stored encrypted on-device
via the OS keychain through Electron `safeStorage`, in
`userData/gladdis-keys.json`), or via environment variables which take
precedence and aren't persisted:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...
export OPENAI_API_KEY=sk-...
export XAI_API_KEY=xai-...   # GROK_API_KEY is also accepted
```

Model layer lives in `src/main/models/` (`KeyStore.ts`, `ChatService.ts`,
`providerRouting.ts`, `browserTools.ts`, and `providers/`).

### Chat, planning, and execution

The composer sends agent-mode turns by default. `turnContextPolicy` and
`selectAgentToolProfile` choose a lean starting tool profile from the user text,
recent context, active page state, and workspace state. Every profile includes
`request_tools`, so the model can pull in filesystem, browser, or research tools
mid-turn instead of stopping when the first guess is too narrow.

The shared API-provider loop lives in
`src/main/models/agentLoopRunner.ts` and is dispatched through
`src/main/models/providerRouting.ts` for Anthropic, Google, OpenAI, and Grok.
Codex and Claude Code use their own embedded-runtime paths, but all browser work
still routes through `BrowserTools.run(...)`.

Tool families:

- **Search / research** — `search`, `search_open`, `deep_search`, `fetch_page`.
  Web search is intentionally routed through Gladdis so results open in the
  visible Chromium tab.
- **Browser** — `browse_task`, `read_page`, `navigate`,
  `grep_page`, `grep_click`, `grep_type`, `click_xy`, `type_text`, `press_key`,
  `execute_in_browser`, `cdp_command`, `screenshot`, `screenshot_app`.
  Prefer `grep_page` for discovery and `grep_click` / `grep_type` for direct
  action when the target is identifiable from page text or selectors.
- **Repo intelligence** — `repo_overview`, `search_repo`, `read_spans`,
  `research_dossier`, `verify_change`.
- **Filesystem** (`src/main/fs/FileTools.ts`) — `read_file`, `write_file`,
  `edit_file` (exact unique string replace, or `replace_all`), `list_dir`, and
  `search_files` (recursive case-insensitive content search with an optional
  file-name glob). This is how the model reads and writes **code** on the local
  machine when you ask. Reads are size-capped; writes are auto-applied (create /
  overwrite / surgical edit) and the resulting `path · +added -removed` summary
  is surfaced in chat. Scope is the whole filesystem the OS user can reach
  (`search_files` skips `node_modules`/`.git`/build dirs). Paths may be absolute
  or relative to the process working directory.
- **Memory** — `recall_history`, plus working-memory tools for runtimes that
  expose them.

### Codex inside Gladdis

Codex runs through the local `codex app-server` for repo, shell, and file work,
with unrestricted read/write access as the current OS user. The workspace folder
button only chooses Codex's starting `cwd`; it is not a write boundary or
sandbox. Codex is not allowed to become a second browser automation stack.
Gladdis is the browser owner: page reading, UI preview, screenshots, and visual verification
must flow through the embedded `WebContentsView` tab via app-server dynamic tools
(`gladdis.search`, `gladdis.fetch_page`, `gladdis.browse_task`,
`gladdis.read_page`, `gladdis.grep_page`, `gladdis.screenshot`) or through Gladdis's own post-Codex
preview handoff.

### Claude Code inside Gladdis

Claude Code runs through its local CLI. For browser and Gladdis-specific context
work, Gladdis registers a local HTTP MCP server named `gladdis` and passes it to
Claude Code for the active session. The bridge exposes search, page-read,
browser-drive, repo-intelligence, recall, and working-memory tools; native
Claude Code shell/file abilities remain available for local code work.

The Codex config disables native web search for Gladdis sessions, and the main
process blocks external browser commands such as Playwright/Puppeteer visual
runs, Chrome/Chromium headless screenshots, OS URL openers, and direct probing
of Chrome remote-debugging ports. Normal repo commands like installs, builds,
tests, and dev-server launches remain available; user-facing local previews are
opened and screenshot-confirmed in Gladdis's embedded browser.

### Token discipline / conversation memory

Chat history is **not** replayed in full on every turn, and past chats are never
summarized into the prompt automatically. The renderer sends only the last
`RECENT_TURNS` (8) messages verbatim; the full conversation already lives on
disk (`ChatStore`, `userData/gladdis-chats.json`). When the user asks to resume
or the model needs older context, it must call `recall_history` — list linked
turns, search them by query, or re-read an earlier tool result in full by its
`tool_call_id`.

Reopening the same saved chat after an app restart is separate from starting a
fresh chat from the composer. A saved chat may keep a provider thread id so
Codex can use `thread/resume` for that same conversation. A fresh chat gets a new
provider thread. If the user asks to pick up where they left off, `recall_history`
uses the current chat's explicit lineage when present, otherwise it treats the
most recently updated saved chat as the obvious previous chat.

### Tool-surface optimization (selection, caching, normalization)

Gladdis keeps prompt/tool payload size low by sending a focused tool set first:

- `selectAgentToolProfile(userText)` chooses a lean starting profile:
  - `conversation`: memory tools only
  - `filesystem`: repo + fs tools
  - `browser`: browse/read/click/capture tools
  - `research`: search/fetch/browse-task tools
  - `full`: broad prompts
- Every profile includes `request_tools`, so the model can escalate mid-turn:
  - `request_tools({ group: 'filesystem' })` for a broad domain grant
  - `request_tools({ tools: [...] })` for exact-token-efficient escalation
- `request_tools` normalizes inputs (aliases, punctuation, casing, spacing) so
  values like `web search`, `FS`, `file_system`, and `read-file` resolve to
  canonical tool/group names.
- In-memory caches reuse resolved tool signatures and normalized names so repeated
  prompts and repeats of the same requested set stay O(1).

Recent benchmark snapshot (raw tool JSON only):
- Full surface (`39` tools): ~`26,107` chars (`~6,537` OpenAI tokens)
- Conversation profile (`7` tools): ~`3,784` chars (`~946` OpenAI tokens)
- Filesystem profile (`24` tools): ~`15,434` chars (`~3,861` OpenAI tokens)
- Browser profile (`23` tools): ~`15,431` chars (`~3,866` OpenAI tokens)
- Research profile (`12` tools): ~`9,705` chars (`~2,433` OpenAI tokens)

Within a single browser-capable run, bulky execution results (page reads,
file reads, command output) are kept verbatim only for the most recent `VERBATIM_TOOL_RESULTS`
(4) calls; older ones collapse to a `[trimmed]` stub that the model can expand
again via `recall_history`. And the static system prompt + tool schemas are sent
with Anthropic **prompt caching** (`cache_control: ephemeral`), so they aren't
re-billed each loop iteration. Net effect: prompt size stays roughly flat
instead of growing with the conversation.

### Custom agents

Saved agents are stored in `userData/gladdis-agents.json`. The Agent Builder can
run quick or deep optimization: quick uses a compact repo overview, while deep
adds repo search, targeted span reads, and a research dossier before distilling
a blueprint. Saved blueprint fields include model preferences, tool constraints,
known paths/commands, workflow and verification steps, assumptions, fallbacks,
and validation notes. At runtime those fields are injected into the agent system
block and tool policy.

> Because writes apply immediately with no per-file confirmation, treat
> browser-capable/code-capable turns like giving the model a shell: only point it
> at code you're willing to have changed.

## Trust model

Gladdis is a **trusted local desktop app**, not a sandboxed assistant. The
trust boundary is the OS user, not the model: gladdis assumes whoever
launched it is authorized for everything the OS user is, and gives the model
the same reach so it can act, not just suggest. That is the entire point of
the app.

What the agent can do, by design, on the OS user's behalf:

- Read and write any file the OS user can reach (no per-file confirmation).
- Run arbitrary shell commands, including with `sudo` (passwordless on this
  machine if the OS user has it).
- Drive the embedded Chromium via the full Chrome DevTools Protocol — clicks,
  typing, navigation, JavaScript injection.
- Issue any Anthropic / Google / Grok / OpenAI / Codex / Claude Code call the
  configured keys authorize, and keep streaming results into your
  conversation.

There are **no built-in denylists, command gates, or "are you sure?"
prompts**. `run_command` and `cdp_command` are intentionally unrestricted.
If you don't want the model to overwrite something, don't point it at that
folder; commit before agent-driven sessions and `git status` is your undo.

API keys themselves are stored encrypted (`safeStorage`) at
`userData/gladdis-keys.json` with mode `0600`, but their *use* is unaudited
at the byte level — keys can still leak via screenshots, logs, or shared
chat transcripts.

## Status

Browser, tabs, layout, full CDP plumbing, streamed multi-provider chat,
Codex/Claude Code embedded runtimes, local terminal, saved chats, custom agents,
memory dreaming, and the current browser/filesystem execution loop are
implemented. Use `npm run check` for the repo's current typecheck + test gate;
use `npm run build` for production bundle validation.
