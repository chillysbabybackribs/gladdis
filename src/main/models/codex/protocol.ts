/**
 * Codex app-server protocol — curated reference types for gladdis's integration.
 *
 * HAND-MAINTAINED subset of the `codex app-server` JSON-RPC protocol, mirroring
 * exactly the surface gladdis touches. NOT the full generated dump.
 *
 * Ground truth (regenerate to verify against the installed CLI):
 *     codex app-server generate-ts --out /tmp/cxschema
 *     codex app-server generate-json-schema --out /tmp/cxschema
 * The generated files live under `<out>/` (top level) and `<out>/v2/` (the
 * current thread/turn API). This file tracks the **v2 namespace**, verified
 * against codex-cli 0.141.0.
 *
 * Last audited from: codex-cli 0.141.0 (auth: ChatGPT OAuth, ~/.codex/auth.json).
 *
 * Transport: spawn `codex app-server` (stdio). Messages are JSON-RPC 2.0 framed
 * as JSONL (one JSON object per line). NOTE: the server OMITS the "jsonrpc":"2.0"
 * member on outbound responses/notifications — JSON-RPC-*shaped*, not strict.
 * Send requests WITH `"jsonrpc":"2.0"`; do not require it when parsing inbound.
 *
 * Lifecycle:
 *   1. -> initialize             (handshake; always first)
 *   2. -> initialized            (notification acknowledging the handshake)
 *   3. -> thread/start or thread/resume (returns { thread } whose .id is the threadId)
 *   4. -> turn/start             ({ threadId, input: UserInput[], ...overrides })
 *   5. <- streamed notifications until `turn/completed`:
 *         turn/started, item/started, item/agentMessage/delta, item/completed,
 *         item/commandExecution/outputDelta, item/reasoning/textDelta,
 *         turn/diff/updated, turn/completed, error
 *   <- approval REQUESTS (server->client) you MUST answer or the turn blocks:
 *         item/commandExecution/requestApproval -> { decision: CommandExecutionApprovalDecision }
 *         item/fileChange/requestApproval       -> { decision: FileChangeApprovalDecision }
 *      Avoid them by choosing approvalPolicy:"never" + a sandbox that doesn't ask.
 *   Abort a running turn with `turn/interrupt`.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type RequestId = number | string
export type ThreadId = string
export type TurnId = string

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// JSON-RPC envelopes (as gladdis reads/writes them)
// ---------------------------------------------------------------------------

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc?: '2.0'
  id: RequestId
  method: M
  params: P
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc?: '2.0'
  id: RequestId
  result: R
}

export interface JsonRpcError {
  jsonrpc?: '2.0'
  id: RequestId
  error: { code: number; message: string; data?: JsonValue }
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc?: '2.0'
  method: M
  params: P
}

/** Any line read off the app-server's stdout. */
export type IncomingMessage =
  | JsonRpcSuccess
  | JsonRpcError
  | ServerNotification
  | ServerRequest

// ---------------------------------------------------------------------------
// Enums / policy
// ---------------------------------------------------------------------------

/**
 * How aggressively Codex asks before acting. Use "never" to suppress approval
 * requests entirely (combine with a sandbox so it stays safe).
 */
export type AskForApproval =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean
        rules: boolean
        skill_approval: boolean
        request_permissions: boolean
        mcp_elicitations: boolean
      }
    }

/** Coarse sandbox selector passed to thread/start. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Fine-grained sandbox policy passed to turn/start (sandboxPolicy). */
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: JsonValue }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'

/** Decision for item/commandExecution/requestApproval. */
export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: JsonValue } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: JsonValue } }

/** Decision for item/fileChange/requestApproval. */
export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

// ---------------------------------------------------------------------------
// Client -> Server requests (the RPCs gladdis calls)
// ---------------------------------------------------------------------------

export interface ClientInfo {
  name: string
  title: string | null
  version: string
}

export interface InitializeParams {
  clientInfo: ClientInfo
  capabilities?: {
    experimentalApi?: boolean
    optOutNotificationMethods?: string[] | null
    requestAttestation?: boolean
    [k: string]: JsonValue | undefined
  } | null
}

export interface InitializeResponse {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

/** thread/start — opens a thread. Returns { thread }. */
export interface ThreadStartParams {
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  config?: { [key: string]: JsonValue } | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  serviceTier?: string | null
  serviceName?: string | null
  ephemeral?: boolean | null
  dynamicTools?: JsonValue[] | null
}

/** thread/resume — reopens an existing thread by id. */
export interface ThreadResumeParams {
  threadId: ThreadId
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandbox?: SandboxMode | null
  config?: { [key: string]: JsonValue } | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  serviceTier?: string | null
  serviceName?: string | null
  dynamicTools?: JsonValue[] | null
}

/** One piece of user input for a turn. Text REQUIRES `text_elements` (use []). */
export type UserInput =
  | { type: 'text'; text: string; text_elements: JsonValue[] }
  | { type: 'image'; url: string; detail?: JsonValue }
  | { type: 'localImage'; path: string; detail?: JsonValue }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

/** turn/start — runs one user turn. Overrides default to the thread's settings. */
export interface TurnStartParams {
  threadId: ThreadId
  input: UserInput[]
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  sandboxPolicy?: SandboxPolicy | null
  model?: string | null
  effort?: ReasoningEffort | null
  summary?: ReasoningSummary | null
  serviceTier?: string | null
  clientUserMessageId?: string | null
  outputSchema?: JsonValue | null
}

export interface TurnInterruptParams {
  threadId: ThreadId
  turnId?: TurnId | null
}

export interface ThreadUnsubscribeParams {
  threadId: ThreadId
}

export interface ThreadCompactStartParams {
  threadId: ThreadId
}

export interface GetAuthStatusParams {
  includeToken?: boolean | null
  refreshToken?: boolean | null
}

export interface GetAuthStatusResponse {
  /** "chatgpt" | "apikey" | null. Present (non-null) => authenticated. */
  authMethod: string | null
  authToken: string | null
  requiresOpenaiAuth: boolean | null
}

/** Helper to build a plain-text turn input. */
export const textInput = (text: string): UserInput => ({ type: 'text', text, text_elements: [] })

/**
 * `model/list` response. Codex returns the list under `data` (older builds may
 * use `items`); each entry's stable id is `id` (falls back to `model`). Only the
 * fields gladdis reads are typed here — the real entry has reasoning efforts,
 * modalities, service tiers, etc.
 */
export interface CodexModelEntry {
  id?: string
  model?: string
  displayName?: string
  name?: string
  isDefault?: boolean
  hidden?: boolean
  defaultReasoningEffort?: ReasoningEffort
  supportedReasoningEfforts?: Array<{ reasoningEffort?: ReasoningEffort; description?: string }>
  inputModalities?: string[]
  supportsPersonality?: boolean
  [k: string]: JsonValue | undefined
}

export interface ModelListResponse {
  data?: CodexModelEntry[]
  items?: CodexModelEntry[]
  models?: CodexModelEntry[]
}

/** Method -> params map for the calls gladdis makes. */
export interface ClientRequests {
  initialize: InitializeParams
  'thread/start': ThreadStartParams
  'thread/resume': ThreadResumeParams
  'thread/unsubscribe': ThreadUnsubscribeParams
  'thread/compact/start': ThreadCompactStartParams
  'turn/start': TurnStartParams
  'turn/interrupt': TurnInterruptParams
  getAuthStatus: GetAuthStatusParams
  'model/list': Record<string, never>
}
export type ClientRequestMethod = keyof ClientRequests

// ---------------------------------------------------------------------------
// Server -> Client requests (gladdis MUST answer these or the turn blocks)
// ---------------------------------------------------------------------------

export interface CommandExecutionRequestApprovalParams {
  threadId: ThreadId
  turnId: TurnId
  itemId: string
  startedAtMs: number
  approvalId?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
  commandActions?: JsonValue[] | null
}

export interface FileChangeRequestApprovalParams {
  threadId: ThreadId
  turnId: TurnId
  itemId: string
  startedAtMs: number
  reason?: string | null
  grantRoot?: string | null
}

export type ServerRequest =
  | {
      method: 'item/commandExecution/requestApproval'
      id: RequestId
      params: CommandExecutionRequestApprovalParams
    }
  | {
      method: 'item/fileChange/requestApproval'
      id: RequestId
      params: FileChangeRequestApprovalParams
    }
  // Other server requests exist (item/tool/requestUserInput,
  // item/permissions/requestApproval, mcpServer/elicitation/request, ...);
  // gladdis answers the two above and declines the rest by default.
  | { method: string; id: RequestId; params: JsonValue }

// ---------------------------------------------------------------------------
// Server -> Client notifications: the streamed event feed
// ---------------------------------------------------------------------------

/**
 * A ThreadItem is the atomic unit of a turn (user msg, agent msg, a command
 * execution, a file change, a tool call, reasoning, etc.). Carried by
 * item/started and item/completed. Discriminated by `type`.
 *
 * gladdis mapping -> ChatStreamEvent:
 *   agentMessage          : final text (already streamed via agentMessage/delta)
 *   commandExecution      : tool_call (started) / tool_result (completed)
 *   fileChange            : tool_call / tool_result (file edits)
 *   mcpToolCall           : tool_call / tool_result
 *   webSearch             : tool_call / tool_result
 *   reasoning             : optional thinking surface
 */
export interface ThreadItemBase {
  type: string
  id: string
  [k: string]: JsonValue | undefined
}
export type ThreadItem = ThreadItemBase

export interface AgentMessageDeltaParams {
  threadId: ThreadId
  turnId: TurnId
  itemId: string
  delta: string
}

export interface ItemLifecycleParams {
  item: ThreadItem
  threadId: ThreadId
  turnId: TurnId
  startedAtMs?: number
  completedAtMs?: number
}

export interface TurnLifecycleParams {
  threadId: ThreadId
  turn: { id: TurnId; status?: string; error?: JsonValue | null; [k: string]: JsonValue | undefined }
}

export interface ThreadStartedParams {
  thread: { id: ThreadId; [k: string]: JsonValue | undefined }
}

export interface ErrorParams {
  message?: string
  [k: string]: JsonValue | undefined
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number
  inputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown
  total: TokenUsageBreakdown
  modelContextWindow?: number | null
}

export interface ThreadTokenUsageUpdatedParams {
  threadId: ThreadId
  turnId: TurnId
  tokenUsage: ThreadTokenUsage
}

/**
 * The notification methods gladdis listens for. (The full ServerNotification union
 * is ~60 variants; these are the ones we translate. Unknown methods are ignored.)
 */
export type ServerNotification =
  | { method: 'thread/started'; params: ThreadStartedParams }
  | { method: 'turn/started'; params: TurnLifecycleParams }
  | { method: 'turn/completed'; params: TurnLifecycleParams }
  | { method: 'turn/diff/updated'; params: JsonValue }
  | { method: 'item/started'; params: ItemLifecycleParams }
  | { method: 'item/completed'; params: ItemLifecycleParams }
  | { method: 'item/agentMessage/delta'; params: AgentMessageDeltaParams }
  | { method: 'item/reasoning/textDelta'; params: JsonValue }
  | { method: 'item/commandExecution/outputDelta'; params: JsonValue }
  | { method: 'thread/tokenUsage/updated'; params: ThreadTokenUsageUpdatedParams }
  | { method: 'thread/compacted'; params: JsonValue }
  | { method: 'error'; params: ErrorParams }
  | { method: string; params: JsonValue }
