import type { TabManager } from '../TabManager'
import type { PageExtractor } from '../extract/PageExtractor'
import type { ChatStore } from './ChatStore'
import type { Conversation, ConversationMeta } from '../../../shared/types'
import { FileTools } from '../fs/FileTools'
import { digestPage } from './PageDigest'
import { AGENT_TOOLS, toolGroupNames } from './agentTools'
import type { LlmComplete } from '../pipeline/Planner'
import { orchestrate } from '../pipeline/orchestrate'
import type { PipelineProgressEvent } from '../pipeline/Runner'
import { generatePipelineFinalResponse } from '../pipeline/finalResponse'
import { runUnifiedSearch } from './unifiedSearch'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { KeyStore } from './KeyStore'
import { GoogleGenAI } from '@google/genai'
import { CodebaseAuditor } from './CodebaseAuditor'

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const TOOLS: ToolDef[] = AGENT_TOOLS

export interface ToolOutcome {
  text: string
  imageBase64?: string
  ok: boolean
}

const cap = (s: string, n = 24_000) => (s.length > n ? s.slice(0, n) + '\n…[truncated]' : s)
const execFileAsync = promisify(execFile)
// A healthy xclip read/write returns in single-digit milliseconds. If it
// hasn't finished in a few seconds the X selection owner is wedged, so cap the
// clipboard timeout well below the generic 10-min command ceiling.
const CLIPBOARD_TIMEOUT_MS = 4_000
const CLIPBOARD_SELECTIONS = new Set(['clipboard', 'primary'])
const normalizeSelection = (selection: unknown): 'clipboard' | 'primary' => {
  const value = String(selection ?? '').trim().toLowerCase()
  return CLIPBOARD_SELECTIONS.has(value) ? (value as 'clipboard' | 'primary') : 'clipboard'
}
const parseTimeoutMs = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 600_000
  return Math.min(600_000, Math.max(250, Math.floor(parsed)))
}

interface SpawnResult {
  stdout: string
  stderr: string
}

// Writes `input` to a command's stdin and waits for it to exit.
//
// stdout/stderr are intentionally set to 'ignore' rather than 'pipe'. xclip -i
// daemonizes itself (it must stay resident to serve the X selection), and the
// child it forks inherits any open stdio fds. If we keep stdout/stderr piped,
// those fds never close, so the 'close' event never fires and the call hangs
// until the timeout fires (minutes). Ignoring them lets the parent see the
// fork exit immediately. The command produces no output we need anyway.
const execFileWithInput = (
  file: string,
  args: string[],
  input: string,
  _maxBuffer = 10 * 1024 * 1024,
  timeoutMs = 600_000
): Promise<SpawnResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err: any = new Error(`Command timed out after ${timeoutMs}ms.`)
        err.code = 'ETIMEDOUT'
        err.signal = 'SIGTERM'
        child.kill('SIGTERM')
        reject(err)
      }, timeoutMs)
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout: '', stderr: '' })
        return
      }
      const err: any = new Error(`Command failed with exit code ${code}`)
      err.code = code
      reject(err)
    })
    child.stdin.on('error', () => { /* child gone before we finished writing; 'close'/'error' handles it */ })
    child.stdin.write(input)
    child.stdin.end()
  })
}

const compactTurn = (text: string, max = 180): string => {
  const snippet = text.replace(/\s+/g, ' ').trim()
  return snippet.length > max ? snippet.slice(0, max) + '...' : snippet
}

const formatConversationDate = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const conversationSummary = (conv: Conversation): string => {
  if (conv.summary?.trim()) return conv.summary.trim()
  return conv.messages
    .filter((m) => m.text.trim())
    .slice(0, 6)
    .map((m) => `${m.role}: ${compactTurn(m.text)}`)
    .join('\n')
}

const conversationTranscript = (conv: Conversation): string =>
  conv.messages
    .map((m, i) => {
      const tools = (m.tools ?? [])
        .map((t) => `  · ${t.tool} (${t.status})${t.preview ? `: ${t.preview}` : ''}`)
        .join('\n')
      return `#${i + 1} ${m.role}:\n${m.text}${tools ? `\n${tools}` : ''}`
    })
    .join('\n\n')

const conversationMetaSummary = (conv: ConversationMeta): string =>
  conv.summary?.trim() || '(no summary yet)'

const VALIDATION_COMMANDS = {
  typecheck: ['npm', ['run', 'typecheck']],
  test: ['npm', ['test']],
  build: ['npm', ['run', 'build']],
  check: ['npm', ['run', 'check']]
} as const

type ValidationCheck = keyof typeof VALIDATION_COMMANDS
const DEFAULT_PUBLISH_MESSAGE = 'Update Gladdis app'

export interface ToolContext {
  tabId: string
  conversationId?: string | null
  fullResults?: Map<string, string>
  llm?: LlmComplete
  onProgress?: (event: PipelineProgressEvent) => void
  /**
   * Tools the model has pulled in this turn via request_tools, on top of the
   * lean starting profile. The provider loop rebuilds its tool list from
   * profile ∪ grantedTools after each step, so a model that needs filesystem
   * or browser tools asks for them and continues — it never narrates "I can't".
   */
  grantedTools?: Set<string>
}

export class BrowserTools {
  private readonly files = new FileTools()
  private appCapture: (() => Promise<string>) | null = null
  private readonly taskDone = new Map<string, Map<string, string>>()

  private readonly pageCache = new Map<string, string>()
  private readonly PAGE_CACHE_LIMIT = 32

  constructor(
    public readonly tabs: TabManager,
    public readonly extractor: PageExtractor,
    public readonly chats: ChatStore,
    public readonly keys?: KeyStore
  ) {}

  setAppCapture(fn: () => Promise<string>): void {
    this.appCapture = fn
  }

  setWorkspaceRoot(root: string | null): void {
    this.files.setRoot(root)
  }

  getWorkspaceRoot(): string | null {
    return this.files.getRoot()
  }

  private taskScope(ctx: ToolContext): Map<string, string> {
    const key = ctx.conversationId || ctx.tabId
    let scope = this.taskDone.get(key)
    if (!scope) {
      if (this.taskDone.size >= 64) this.taskDone.delete(this.taskDone.keys().next().value!)
      scope = new Map<string, string>()
      this.taskDone.set(key, scope)
    }
    return scope
  }

  private rememberDone(ctx: ToolContext, key: string, summary: string): void {
    const scope = this.taskScope(ctx)
    if (!scope.has(key) && scope.size >= 200) scope.delete(scope.keys().next().value!)
    scope.set(key, summary)
  }

  async run(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
    const tabId = ctx.tabId
    try {
      switch (name) {

        // ── Perceive ──────────────────────────────────────────────────────────

        case 'read_page': {
          const cacheKey = `${tabId}:${args.focus ?? ''}:${args.viewportOnly === true}`
          const cached = this.pageCache.get(cacheKey)
          if (cached) return { ok: true, text: cached }

          const capData = await this.extractor.run(tabId)
          const digest = digestPage(capData, {
            focus: args.focus ? String(args.focus) : undefined,
            viewportOnly: args.viewportOnly === true
          })

          if (this.pageCache.size >= this.PAGE_CACHE_LIMIT) {
            const first = this.pageCache.keys().next().value
            if (first !== undefined) this.pageCache.delete(first)
          }
          this.pageCache.set(cacheKey, digest)
          return { ok: true, text: digest }
        }

        // ── Capture ───────────────────────────────────────────────────────────

        case 'screenshot': {
          const fullPage = args.fullPage === true
          const imageBase64 = await this.tabs.capturePagePng(tabId, fullPage)
          return {
            ok: true,
            text: `${fullPage ? 'Full-page' : 'Visible viewport'} screenshot of the active tab captured.`,
            imageBase64
          }
        }

        case 'screenshot_app': {
          if (!this.appCapture) return { ok: false, text: 'screenshot_app: app capture not available.' }
          const dataUrl = await this.appCapture()
          // appCapture returns a data: URL; strip the prefix for the image field.
          const imageBase64 = dataUrl.replace(/^data:image\/png;base64,/, '')
          if (!imageBase64) return { ok: false, text: 'screenshot_app: could not capture the app window.' }
          return { ok: true, text: 'Screenshot of the entire Gladdis app window captured.', imageBase64 }
        }

        // ── Search ────────────────────────────────────────────────────────────

        case 'search':
          return this.search(args, ctx)

        case 'fetch_page':
          return this.fetchPage(args, ctx)

        // ── Task (pipeline) ───────────────────────────────────────────────────

        case 'browse_task': {
          const task = String(args.task ?? '').trim()
          if (!task) return { ok: false, text: 'browse_task: "task" is required.' }
          const llm = ctx.llm
          if (!llm) return { ok: false, text: 'browse_task: LLM not wired for this request.' }
          const site = args.site ? String(args.site) : undefined
          const deps = {
            cdpSend: (id: string, m: string, p?: Record<string, unknown>) =>
              this.tabs.cdpSend(id, m, p),
            capture: (id: string) => this.extractor.run(id)
          }
          const trajectory = await orchestrate({
            tabId, task, site, deps,
            llm,
            onProgress: ctx.onProgress,
            onLog: (msg) => console.log(msg)
          })
          const finalCapture = await this.extractor.run(tabId)
          const answer = await generatePipelineFinalResponse({
            task, trajectory, finalCapture, llm
          })
          return { ok: true, text: answer }
        }

        // ── Drive ─────────────────────────────────────────────────────────────

        case 'execute_in_browser': {
          const res = await this.tabs.executeJavaScript(tabId, String(args.code ?? ''))
          return res.success
            ? { ok: true, text: cap(safeJson(res.result)) }
            : { ok: false, text: `Error: ${res.error}` }
        }
        case 'navigate': {
          this.tabs.navigate(tabId, String(args.url ?? ''))
          return { ok: true, text: `Navigating to ${args.url}` }
        }
        case 'click_xy': {
          await this.dispatchClick(tabId, Number(args.x), Number(args.y))
          return { ok: true, text: `Clicked at (${args.x}, ${args.y}).` }
        }
        case 'press_key': {
          await this.pressKey(tabId, String(args.key ?? ''))
          return { ok: true, text: `Pressed ${args.key}.` }
        }
        case 'type_text': {
          await this.typeText(tabId, String(args.text ?? ''))
          return { ok: true, text: `Typed ${String(args.text).length} chars.` }
        }
        case 'cdp_command': {
          const out = await this.tabs.cdpSend(tabId, String(args.method), args.params ?? {})
          return { ok: true, text: cap(safeJson(out)) }
        }

        /* ----------------- Local filesystem ----------------- */
        case 'read_file': {
          const path = String(args.path ?? '')
          let r
          try {
            r = await this.files.read(path, optNum(args.start_line), optNum(args.end_line), args.full === true)
          } catch (err) {
            const msg = (err as Error)?.message ?? String(err)
            if (/ENOENT|no such file/i.test(msg)) {
              const near = await this.files.nearbyMatches(path)
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
              ? `\nUse search_files to locate relevant symbols before reading more, or next range: read_file({"path":${JSON.stringify(r.path)},"start_line":${r.endLine + 1},"end_line":${Math.min(r.endLine + 120, r.totalLines)}}). Use full:true only if needed.`
              : ''
          const header = `${r.path} — ${window}${r.truncated ? ' (truncated)' : ''}${next}`
          return { ok: true, text: cap(`${header}\n\n${r.content}`, 30_000) }
        }
        case 'write_file': {
          const r = await this.files.write(String(args.path ?? ''), String(args.content ?? ''))
          return {
            ok: true,
            text: `${r.created ? 'Created' : 'Overwrote'} ${r.path} (${r.bytes} bytes; +${r.diff.added} -${r.diff.removed})`
          }
        }
        case 'edit_file': {
          const r = await this.files.edit(
            String(args.path ?? ''),
            String(args.old_string ?? ''),
            String(args.new_string ?? ''),
            args.replace_all === true
          )
          return {
            ok: true,
            text: `Edited ${r.path} — ${r.replacements} replacement(s); +${r.diff.added} -${r.diff.removed}\n${r.diff.preview}`
          }
        }
        case 'list_dir': {
          const r = await this.files.list(String(args.path ?? '.'))
          const body = r.entries
            .map((e) => `${e.type === 'dir' ? 'd' : '-'} ${e.name}${e.type === 'file' ? ` (${e.size}b)` : ''}`)
            .join('\n')
          return { ok: true, text: cap(`${r.path}${r.truncated ? ' (truncated)' : ''}\n${body}`) }
        }
        case 'search_files': {
          const search = searchQueryArgs(args)
          const r = await this.files.search(
            search.query,
            args.path ? String(args.path) : '.',
            args.glob ? String(args.glob) : undefined,
            optNum(args.context_lines) ?? undefined,
            optNum(args.max_results) ?? undefined,
            search.regex
          )
          const body = r.hits.map((h) => {
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
          return {
            ok: true,
            text: cap(`${r.hits.length} hit(s)${r.truncated ? ' (truncated)' : ''}\n${body}`)
          }
        }
        case 'read_clipboard':
          return this.readClipboard(args)

        case 'write_clipboard':
          return this.writeClipboard(args)

        case 'run_validation':
          return this.runValidation(args)

        case 'run_command':
          return this.runCommand(args)

        case 'publish_changes':
          return this.publishChanges(args)

        case 'audit_codebase': {
          const root = this.getWorkspaceRoot() || process.cwd();
          const googleKey = this.keys?.get('google') || process.env.GEMINI_API_KEY;
          if (!googleKey) {
            return {
              ok: false,
              text: 'Error: Google Gemini API key not found in key storage.'
            };
          }
          const ai = new GoogleGenAI({ apiKey: googleKey });
          const auditor = new CodebaseAuditor(root, ai);
          const auditReport = await auditor.runAudit(args.focusPath);
          return {
            ok: true,
            text: auditReport
          };
        }

        case 'request_tools':
          return this.requestTools(args, ctx)

        case 'recall_history':
          return this.recallHistory(args, ctx)

        // === Workspace + Per-Task Memory ===
        case 'memory_write':
          return (await import('./memoryStore')).memoryWrite(args)
        case 'memory_read':
          return (await import('./memoryStore')).memoryRead(args)
        case 'memory_list':
          return (await import('./memoryStore')).memoryList(args)
        case 'memory_forget':
          return (await import('./memoryStore')).memoryForget(args)
        case 'memory_create_task':
          return (await import('./memoryStore')).memoryCreateTask(args)

        default:
          return { ok: false, text: `Unknown tool: ${name}` }
      }
    } catch (err) {
      return { ok: false, text: `Tool ${name} failed: ${(err as Error)?.message ?? String(err)}` }
    }
  }

  private async requestTools(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
    const group = String(args.group ?? '').trim()
    const names = toolGroupNames(group)
    if (names.length === 0) {
      return { ok: false, text: `request_tools: unknown group "${group}". Use filesystem, browser, or research.` }
    }
    const granted = (ctx.grantedTools ??= new Set<string>())
    for (const name of names) granted.add(name)
    return {
      ok: true,
      text: `Granted ${group} tools for this turn: ${names.join(', ')}. Call them now to continue.`
    }
  }

  private async runCommand(args: Record<string, any>): Promise<ToolOutcome> {
    const command = String(args.command ?? '').trim()
    if (!command) {
      return { ok: false, text: 'run_command: "command" is required.' }
    }
    const timeout = parseTimeoutMs(args.timeout_ms)
    const cwd = (args.cwd ? String(args.cwd).trim() : '') || this.files.getRoot() || process.cwd()
    try {
      // Full access by design: same OS reach as the user, no allowlist, no prompt.
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024
      })
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      return { ok: true, text: cap(`$ ${command}\n${output || '(no output)'}`, 40_000) }
    } catch (err: any) {
      const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT'
      const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
      const prefix = timedOut ? `Command timed out after ${timeout}ms.` : 'Command failed.'
      return { ok: false, text: cap(`$ ${command}\n${prefix}\n${output || 'Command failed.'}`, 40_000) }
    }
  }

  private async readClipboard(args: Record<string, any>): Promise<ToolOutcome> {
    const selection = normalizeSelection(args.selection)
    const timeout = Math.min(parseTimeoutMs(args.timeout_ms || CLIPBOARD_TIMEOUT_MS), CLIPBOARD_TIMEOUT_MS)
    try {
      const { stdout, stderr } = await execFileAsync('xclip', ['-o', '-selection', selection], {
        maxBuffer: 10 * 1024 * 1024,
        timeout
      })
      const payload = String(stdout ?? '').trim()
      if (!payload) {
        return { ok: true, text: `Clipboard [${selection}] is empty.` }
      }
      const extra = String(stderr ?? '').trim()
      return {
        ok: true,
        text: cap(`Clipboard [${selection}]:\n${payload}${extra ? `\n${extra}` : ''}`, 40_000)
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { ok: false, text: 'read_clipboard: xclip not found. Install with: sudo apt-get install -y xclip' }
      }
      const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT'
      const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
      const prefix = timedOut ? `read_clipboard timed out after ${timeout}ms.` : 'read_clipboard failed:'
      return { ok: false, text: `read_clipboard failed:\n${prefix}\n${output || 'Could not read clipboard.'}` }
    }
  }

  private async writeClipboard(args: Record<string, any>): Promise<ToolOutcome> {
    const text = String(args.text ?? '')
    if (!text) {
      return { ok: false, text: 'write_clipboard: "text" is required.' }
    }
    const selection = normalizeSelection(args.selection)
    const argsOut = ['-selection', selection]
    const timeout = Math.min(parseTimeoutMs(args.timeout_ms || CLIPBOARD_TIMEOUT_MS), CLIPBOARD_TIMEOUT_MS)
    try {
      const { stdout, stderr } = await execFileWithInput('xclip', ['-i', ...argsOut], text, 10 * 1024 * 1024, timeout)
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      return {
        ok: true,
        text: `Wrote ${text.length} character(s) to clipboard [${selection}].${output ? `\n${output}` : ''}`
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { ok: false, text: 'write_clipboard: xclip not found. Install with: sudo apt-get install -y xclip' }
      }
      const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT' || err?.message?.includes('timed out')
      const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
      const prefix = timedOut ? `write_clipboard timed out after ${timeout}ms.` : 'write_clipboard failed:'
      return { ok: false, text: `write_clipboard failed:\n${prefix}\n${output || 'Could not write clipboard.'}` }
    }
  }

  private async runValidation(args: Record<string, any>): Promise<ToolOutcome> {
    const check = String(args.check ?? '').trim() as ValidationCheck
    const command = VALIDATION_COMMANDS[check]
    if (!command) {
      return {
        ok: false,
        text: 'run_validation: "check" must be one of typecheck, test, build, or check.'
      }
    }

    const cwd = this.files.getRoot() ?? process.cwd()
    const [bin, argv] = command
    const pretty = [bin, ...argv].join(' ')
    try {
      const { stdout, stderr } = await execFileAsync(bin, argv, {
        cwd,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024
      })
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      return {
        ok: true,
        text: cap(`PASS: ${pretty}\n${output || '(no output)'}`, 40_000)
      }
    } catch (err: any) {
      const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
      return {
        ok: false,
        text: cap(`FAIL: ${pretty}\n${output || 'Validation failed.'}`, 40_000)
      }
    }
  }

  private async publishChanges(args: Record<string, any>): Promise<ToolOutcome> {
    const cwd = this.files.getRoot() ?? process.cwd()
    const message = commitMessage(args.message)
    const remote = String(args.remote ?? 'origin').trim() || 'origin'
    const requestedBranch = args.branch ? String(args.branch).trim() : ''

    try {
      await git(['rev-parse', '--is-inside-work-tree'], cwd)
      const repoRoot = (await git(['rev-parse', '--show-toplevel'], cwd)).stdout.trim() || cwd
      const before = (await git(['status', '--short'], repoRoot)).stdout.trim()
      if (!before) return { ok: true, text: 'publish_changes: no local changes to publish.' }

      await git(['add', '-A'], repoRoot)
      const staged = await gitQuiet(['diff', '--cached', '--quiet'], repoRoot)
      if (staged.code === 0) return { ok: true, text: 'publish_changes: no staged changes to publish.' }

      await git(['commit', '-m', message], repoRoot)
      const branch = requestedBranch || (await git(['branch', '--show-current'], repoRoot)).stdout.trim()
      if (!branch) {
        return { ok: false, text: 'publish_changes: could not determine the current branch.' }
      }

      await git(['push', '-u', remote, branch], repoRoot, 240_000)
      const commit = (await git(['rev-parse', '--short', 'HEAD'], repoRoot)).stdout.trim()
      const after = (await git(['status', '--short'], repoRoot)).stdout.trim()
      return {
        ok: true,
        text:
          `Published ${commit} to ${remote}/${branch}.\n` +
          `Commit message: ${message}\n` +
          `Changed files before publish:\n${cap(before, 8_000)}` +
          (after ? `\n\nRemaining local changes:\n${cap(after, 8_000)}` : '\n\nWorking tree clean.')
      }
    } catch (err: any) {
      const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim()
      return { ok: false, text: cap(`publish_changes failed:\n${output || String(err)}`, 20_000) }
    }
  }

  /**
   * Recall earlier context for the current conversation. The recent tail is
   * already in the live message window, so this reads the *persisted* full
   * conversation from ChatStore and returns older turns on demand — either a
   * compact index of all of them, the full text of turns matching a query, or
   * the verbatim result of an earlier tool call by id.
   */
  private recallHistory(args: Record<string, any>, ctx: ToolContext): ToolOutcome {
    // Re-reading a full tool result from earlier in THIS request.
    const toolCallId = args.tool_call_id ? String(args.tool_call_id) : null
    if (toolCallId) {
      const full = ctx.fullResults?.get(toolCallId)
      if (full != null) return { ok: true, text: cap(full, 30_000) }
      return { ok: false, text: `No tool result found for id "${toolCallId}" in this request.` }
    }

    const scope = args.scope === 'all' ? 'all' : 'conversation'
    const query = args.query ? String(args.query).trim() : ''
    const conversationId = args.conversation_id ? String(args.conversation_id).trim() : ''

    if (conversationId) {
      const conv = this.chats.get(conversationId)
      if (!conv) return { ok: false, text: `No saved Gladdis conversation found for id "${conversationId}".` }
      return {
        ok: true,
        text: cap(
          `Gladdis conversation "${conv.title}"\n` +
          `id: ${conv.id}\n` +
          `created: ${formatConversationDate(conv.createdAt)}\n` +
          `updated: ${formatConversationDate(conv.updatedAt)}\n\n` +
          conversationTranscript(conv),
          30_000
        )
      }
    }

    if (scope === 'all') {
      if (!query) {
        const recent = this.chats.list().slice(0, 8)
        if (recent.length === 0) return { ok: true, text: 'No saved Gladdis conversations are stored yet.' }
        const body = recent.map((conv, index) =>
          `${index + 1}. ${conv.title}\n` +
          `   id: ${conv.id} | updated: ${formatConversationDate(conv.updatedAt)}\n` +
          `   summary: ${conversationMetaSummary(conv)}`
        ).join('\n\n')
        return {
          ok: true,
          text:
            'Recent saved Gladdis conversations. ' +
            'Use conversation_id to read the full saved chat only if the summary is not enough.\n\n' +
            body
        }
      }
      const hits = this.chats.search(query, 8)
      if (hits.length === 0) return { ok: true, text: `No saved chats match "${query}".` }
      const body = hits.map((hit, index) =>
        `${index + 1}. ${hit.title}\n` +
        `   id: ${hit.conversationId} | updated: ${formatConversationDate(hit.updatedAt)}\n` +
        `   summary: ${hit.summary || '(no summary yet)'}\n` +
        `   match: ${hit.role} turn #${hit.messageIndex + 1}: ${hit.excerpt}`
      ).join('\n\n')
      return {
        ok: true,
        text:
          `Found ${hits.length} saved chat match(es) for "${query}". ` +
          'Use conversation_id to read the full saved chat only if the summary/match is not enough.\n\n' +
          body
      }
    }

    if (!ctx.conversationId) {
      return { ok: false, text: 'No conversation context is available to recall from.' }
    }
    const conversations = this.chats.lineage(ctx.conversationId)
    if (conversations.length <= 1) {
      const previous = this.chats.previousConversation(ctx.conversationId)
      if (previous && !conversations.some((c) => c.id === previous.id)) {
        conversations.push(previous)
      }
    }
    if (conversations.length === 0 || conversations.every((c) => c.messages.length === 0)) {
      return { ok: true, text: 'No earlier conversation history is stored yet.' }
    }
    const turns = conversations.flatMap((conv, convIndex) =>
      conv.messages.map((m, i) => ({ conv, convIndex, m, i }))
    )

    if (!query) {
      const sections = conversations.map((conv, convIndex) => {
        const source = convIndex === 0 ? 'Current chat' : `Previous chat: ${conv.title}`
        const summary = conversationSummary(conv) || '(no summary yet)'
        return (
          `${source}\n` +
          `id: ${conv.id}\n` +
          `created: ${formatConversationDate(conv.createdAt)} | updated: ${formatConversationDate(conv.updatedAt)}\n` +
          `${conv.messages.length} stored turn(s). Summary:\n${summary}`
        )
      })
      const chainNote =
        conversations.length > 1
          ? ` across ${conversations.length} linked chats`
          : ''
      return {
        ok: true,
        text: cap(
          `Brief conversation overview${chainNote}. ` +
          `Use conversation_id to read a full saved chat, or query for exact matching turns.\n\n${sections.join('\n\n')}`,
          8_000
        )
      }
    }

    // Full text of matching turns (and any tool previews on them).
    const hits = turns.filter(({ m }) => {
        if (m.text.toLowerCase().includes(query.toLowerCase())) return true
        return (m.tools ?? []).some(
          (t) =>
            t.tool.toLowerCase().includes(query.toLowerCase()) ||
            (t.preview ?? '').toLowerCase().includes(query.toLowerCase())
        )
      })
    if (hits.length === 0) return { ok: true, text: `No earlier turns match "${args.query}".` }
    const body = hits
      .map(({ conv, convIndex, m, i }) => {
        const tools = (m.tools ?? [])
          .map((t) => `  · ${t.tool} (${t.status})${t.preview ? `: ${t.preview}` : ''}`)
          .join('\n')
        const source = convIndex === 0 ? 'current chat' : `continued from "${conv.title}"`
        return `#${i + 1} ${source} ${m.role}:\n${m.text}${tools ? `\n${tools}` : ''}`
      })
      .join('\n\n')
    return { ok: true, text: cap(`${hits.length} matching turn(s):\n\n${body}`, 30_000) }
  }

  /**
   * Unified web search: hidden embedded-Chromium SERP discovery, ranked aggregation,
   * then top hits opened in the visible tab for live CDP extraction.
   */
  private async search(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
    const query = String(args.query ?? '').trim()
    if (!query) return { ok: false, text: 'search: "query" is required.' }
    const memKey = `search:${query.toLowerCase()}`
    const prior = this.taskScope(ctx).get(memKey)
    if (prior) {
      return { ok: true, text: `(already searched this query this task — reusing prior results)\n${prior}` }
    }
    const outcome = await runUnifiedSearch(
      { tabs: this.tabs, extractor: this.extractor },
      {
        query,
        tabId: ctx.tabId,
        limitPerQuery: clampInt(args.limit, 1, 8, 4),
        digestTop: clampInt(args.digest_top, 0, 3, 2),
        focus: args.focus ? String(args.focus) : undefined
      }
    )
    if (!outcome.ok) return { ok: false, text: outcome.text }
    this.rememberDone(ctx, memKey, outcome.text)
    return { ok: true, text: outcome.text }
  }

  /**
   * Visible-tab page fetch. This is the deliberate handoff from hidden/off-screen
   * search breadth to something the user can see and the model can read.
   */
  private async fetchPage(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
    const rawUrl = String(args.url ?? '').trim()
    if (!rawUrl) return { ok: false, text: 'fetch_page: "url" is required.' }

    let url: string
    try {
      url = new URL(rawUrl).toString()
    } catch {
      return { ok: false, text: `fetch_page: invalid URL "${rawUrl}".` }
    }

    const memKey = `fetch:${normalizeUrl(url)}`
    const prior = this.taskScope(ctx).get(memKey)
    if (prior) {
      return { ok: true, text: `(already fetched this URL this task — reusing prior digest)\n${prior}` }
    }

    const started = Date.now()
    const beforeNav = await this.currentPageReadiness(ctx.tabId)
    const beforeNavigateMs = Date.now() - started
    const navigateStarted = Date.now()
    this.tabs.navigate(ctx.tabId, url)
    const navigateDispatchMs = Date.now() - navigateStarted
    const readableStarted = Date.now()
    await this.waitForVisibleNavigationReadable(ctx.tabId, url, beforeNav.url)
    const readableMs = Date.now() - readableStarted
    const extractStarted = Date.now()
    const capData = await this.extractor.run(ctx.tabId)
    const extractMs = Date.now() - extractStarted
    const digestStarted = Date.now()
    const digest = digestPage(capData, {
      focus: args.focus ? String(args.focus) : undefined,
      viewportOnly: args.viewportOnly === true
    })
    const digestMs = Date.now() - digestStarted
    const finalUrl = typeof capData.url === 'string' ? normalizeUrl(capData.url) : null
    const timedDigest = [
      `FETCH TIMINGS: preflight=${beforeNavigateMs}ms dispatch=${navigateDispatchMs}ms readable=${readableMs}ms extract=${extractMs}ms digest=${digestMs}ms total=${Date.now() - started}ms`,
      `REQUESTED URL: ${url}`,
      finalUrl && finalUrl !== normalizeUrl(url) ? `FINAL URL: ${capData.url}` : null,
      '',
      digest
    ].filter((line): line is string => line !== null).join('\n')
    this.rememberDone(ctx, memKey, timedDigest)
    if (finalUrl && finalUrl !== memKey.slice('fetch:'.length)) {
      this.rememberDone(ctx, `fetch:${finalUrl}`, timedDigest)
    }
    return { ok: true, text: timedDigest }
  }

  /** Trusted mouse click via CDP (press + release). */
  private async dispatchClick(tabId: string, x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left' as const, clickCount: 1 }
    await this.tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.tabs.cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  }

  /**
   * Trusted text entry. Input.insertText commits the whole string in one CDP
   * call (fast, handles unicode/IME correctly) — far better than per-char key
   * events. Use press_key for non-printing keys like Enter/Tab.
   */
  private async typeText(tabId: string, text: string): Promise<void> {
    await this.tabs.cdpSend(tabId, 'Input.insertText', { text })
  }

  /** Dispatch a single named key (down + up) with correct CDP key params. */
  private async pressKey(tabId: string, key: string): Promise<void> {
    const def = KEY_MAP[key.toLowerCase()]
    if (!def) throw new Error(`Unknown key "${key}"`)
    const common = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      ...(def.text ? { text: def.text } : {})
    }
    await this.tabs.cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
    await this.tabs.cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }

  private async waitForVisibleNavigationReadable(
    tabId: string,
    expectedUrl: string,
    previousUrl: string | null = null,
    timeoutMs = 4_000
  ): Promise<void> {
    const expected = normalizeUrl(expectedUrl)
    const previous = previousUrl ? normalizeUrl(previousUrl) : null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.currentPageReadiness(tabId)
      const current = state.url ? normalizeUrl(state.url) : null
      const readable = state.readyState !== 'loading'
      if (current && readable && (current === expected || (previous !== null && current !== previous))) return
      await sleep(100)
    }
    await this.tabs.waitForNavigationSettled(tabId, 750)
  }

  private async currentPageReadiness(tabId: string): Promise<{ url: string | null; readyState: string | null }> {
    try {
      const res = (await this.tabs.cdpSend(tabId, 'Runtime.evaluate', {
        expression: `({ url: location.href, readyState: document.readyState })`,
        returnByValue: true
      })) as { result?: { value?: { url?: string; readyState?: string } } }
      return {
        url: typeof res.result?.value?.url === 'string' ? res.result.value.url : null,
        readyState: typeof res.result?.value?.readyState === 'string' ? res.result.value.readyState : null
      }
    } catch {
      return { url: null, readyState: null }
    }
  }

}

/** CDP key descriptors for the non-printing keys the agent can press. */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
}

/** Canonicalize a URL for per-task dedup: lowercase host, drop trailing slash + fragment. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s.toLowerCase()
  } catch {
    return raw.trim().replace(/[/#]+$/, '').toLowerCase()
  }
}

function searchQueryArgs(args: Record<string, any>): { query: string; regex: boolean } {
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

function commitMessage(value: unknown): string {
  const raw = String(value ?? '').trim()
  const message = raw || DEFAULT_PUBLISH_MESSAGE
  return message.split(/\r?\n/)[0].slice(0, 200)
}

async function git(
  args: string[],
  cwd: string,
  timeout = 180_000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024
  })
}

async function gitQuiet(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await git(args, cwd)
    return { code: 0, ...result }
  } catch (err: any) {
    return {
      code: typeof err?.code === 'number' ? err.code : 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? '')
    }
  }
}

/** Coerce an optional numeric arg; undefined/NaN → undefined. */
function optNum(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
