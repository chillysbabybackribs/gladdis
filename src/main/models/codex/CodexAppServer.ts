import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type {
  IncomingMessage,
  InitializeResponse,
  JsonValue,
  RequestId,
  ServerNotification,
  ServerRequest
} from './protocol'

const execFileAsync = promisify(execFile)

/** Where to find the codex binary; override with GLADDIS_CODEX_BIN. */
const CODEX_BIN = process.env.GLADDIS_CODEX_BIN || 'codex'

/**
 * One-shot probe of the local codex CLI: is the binary present and what version.
 * Cheap enough to call on demand; does not start the app-server.
 */
export async function probeCodexBinary(): Promise<{ installed: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileAsync(CODEX_BIN, ['--version'], { timeout: 8000 })
    const version = stdout.trim().split(/\s+/).pop() || stdout.trim() || null
    return { installed: true, version }
  } catch {
    return { installed: false, version: null }
  }
}

type Pending = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  method: string
  timer: NodeJS.Timeout
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * Owns a single long-lived `codex app-server` child process and speaks its
 * JSON-RPC-over-JSONL protocol on stdio. One server instance can host many
 * threads (conversations); higher layers route by threadId.
 *
 * Wire detail: the server omits the `"jsonrpc":"2.0"` member on its outbound
 * messages (JSON-RPC-*shaped*). We send it (accepted) and don't require it when
 * parsing. See src/main/models/codex/protocol.ts for the message shapes.
 *
 * Events:
 *   'notification' (msg: ServerNotification) — streamed turn events.
 *   'serverRequest' (msg: ServerRequest)     — approvals etc. the client must answer.
 *   'exit' (code)                            — the child process ended.
 */
export class CodexAppServer extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private rl: Interface | null = null
  private nextId = 1
  private readonly pending = new Map<RequestId, Pending>()
  private startPromise: Promise<InitializeResponse> | null = null

  /** Whether the child process is currently running. */
  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  /**
   * Spawn the app-server (if not already running) and perform the `initialize`
   * handshake. Idempotent: concurrent callers share one start.
   */
  async start(): Promise<InitializeResponse> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart()
    return this.startPromise
  }

  private async doStart(): Promise<InitializeResponse> {
    // gladdis runs Codex fully unsandboxed by design: the user owns this desktop
    // app, and the workspace posture already sets danger-full-access +
    // approvalPolicy "never". On Linux the app-server otherwise wraps every
    // command in bubblewrap, which needs unprivileged user namespaces — a kernel
    // feature restricted on Ubuntu 24.04+ (apparmor_restrict_unprivileged_userns)
    // and hardened Debian, so bwrap's startup init fails and EVERY tool call
    // dies before it runs.
    //
    // The fix is the `-c sandbox_mode=danger-full-access` STARTUP override
    // (verified: it silences the bwrap init; the persisted ~/.codex/config.toml
    // value is NOT consulted for the app-server's startup probe). Note the
    // top-level --dangerously-bypass-approvals-and-sandbox flag does NOT work
    // here — it governs the interactive `exec` path, not `app-server` startup.
    // Set GLADDIS_CODEX_SANDBOX=1 to keep Codex's own sandbox (needs working bwrap).
    const args = process.env.GLADDIS_CODEX_SANDBOX
      ? ['app-server']
      : ['-c', 'sandbox_mode=danger-full-access', 'app-server']
    const proc = spawn(CODEX_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    this.proc = proc

    proc.on('error', (err) => {
      // Spawn failure (e.g. binary missing). Reject everything in flight.
      this.proc = null
      this.startPromise = null
      this.failAll(new Error(`codex app-server failed to start: ${err.message}`))
    })
    proc.on('exit', (code) => {
      const err = new Error(`codex app-server exited (code ${code})`)
      this.failAll(err)
      this.rl?.close()
      this.rl = null
      this.proc = null
      this.startPromise = null
      this.emit('exit', code)
    })
    // app-server logs diagnostics on stderr; surface only for debugging.
    proc.stderr.on('data', (d) => {
      if (process.env.GLADDIS_CODEX_DEBUG) process.stderr.write(`[codex] ${d}`)
    })

    this.rl = createInterface({ input: proc.stdout })
    this.rl.on('line', (line) => this.onLine(line))

    const init = (await this.request('initialize', {
      clientInfo: { name: 'gladdis', title: 'gladdis', version: '0.1.0' },
      capabilities: {
        experimentalApi: true
      }
    })) as InitializeResponse
    // The official app-server lifecycle requires an `initialized` notification
    // after the initialize response and before other methods.
    this.notify('initialized', {})
    return init
  }

  /** Parse one stdout line and dispatch it. Never throws. */
  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: IncomingMessage
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return // ignore non-JSON noise
    }
    const anyMsg = msg as any

    // Response to one of our requests (has id + result/error, no method).
    if (anyMsg.id !== undefined && anyMsg.method === undefined) {
      const p = this.pending.get(anyMsg.id)
      if (!p) return
      this.pending.delete(anyMsg.id)
      clearTimeout(p.timer)
      if (anyMsg.error) {
        const err = new Error(`${p.method}: ${anyMsg.error.message ?? JSON.stringify(anyMsg.error)}`)
        ;(err as any).code = anyMsg.error.code
        ;(err as any).data = anyMsg.error.data
        p.reject(err)
      } else {
        p.resolve(anyMsg.result)
      }
      return
    }

    // Server -> client request (has id AND method): must be answered.
    if (anyMsg.id !== undefined && anyMsg.method) {
      this.emit('serverRequest', msg as ServerRequest)
      return
    }

    // Notification (method, no id).
    if (anyMsg.method) {
      this.emit('notification', msg as ServerNotification)
    }
  }

  /** Send a JSON-RPC request and await its response. */
  request<R = JsonValue>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<R> {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) {
      return Promise.reject(new Error('codex app-server is not running'))
    }
    const id = this.nextId++
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      proc.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  /** Answer a server->client request by its id (no response is awaited). */
  respond(id: RequestId, result: unknown): void {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  /** Fire-and-forget JSON-RPC notification (client -> server). */
  notify(method: string, params: unknown): void {
    const proc = this.proc
    if (!proc || proc.exitCode !== null) return
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Stop the child process. Safe to call repeatedly. */
  dispose(): void {
    this.failAll(new Error('codex app-server disposed'))
    try {
      this.proc?.stdin.end()
    } catch {
      /* ignore */
    }
    this.proc?.kill()
    this.rl?.close()
    this.rl = null
    this.proc = null
    this.startPromise = null
  }
}
