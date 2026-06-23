import type { ModelOption, Provider } from './models'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

const URL_RE = /https?:\/\/|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?/i

const ACTIVE_PAGE_CONTEXT_RE =
  /\b(?:this|current|active|visible|open|loaded)\s+(?:page|tab|site|website|webpage|url)\b|\b(?:on|in)\s+(?:this|the|current|active)\s+(?:page|tab|site|website|webpage)\b/i

const ACTIVE_PAGE_ACTION_RE =
  /\b(?:click|type into|press|scroll|screenshot|read_page|browse_task|reload|go back|go forward)\b/i

const ACTIVE_PAGE_FOLLOWUP_RE =
  /^\s*(?:yes|yeah|yep|ok(?:ay)?|sure|please|do that|go ahead|continue|same|also\b|and\b|then\b|what about\b|how about\b|for (?:that|this|those|these|it|them)\b|(?:that|this|those|these|it|them)\b|the (?:links?|buttons?|images?|results?|article|page|site|form|menu|header|footer)\b)/i

const BROWSER_CONTROL_RE =
  /\b(?:browser|web\s?page|website|url|tab|navigate|open\s+(?:the\s+)?(?:site|website|url|link)|visit\s+(?:the\s+)?(?:site|website|url|link)|click|type into|press|scroll|screenshot|visible tab|active page)\b/i

const LOCAL_SEARCH_RE =
  /\bsearch\s+(?:files?|repo|repository|codebase|source|src\/|directory|folder)\b/i

const WEB_SEARCH_RE =
  /\b(?:search(?:\s+for)?|google|duckduckgo|look up|find|check|read|open|get|review)\b.{0,80}\b(?:web|internet|online|official|docs|documentation)\b|\b(?:search the web|web search|google|duckduckgo|official docs|official documentation|latest|recent|current|state of the art|research)\b/i

const LOCAL_PATH_RE =
  /(?:^|\s)(?:\.{1,2}\/|~\/|\/[\w.-]|[\w.-]+\/[\w./-]*|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|html|cjs|mjs|yml|yaml|toml|lock|env))\b/i

const LOCAL_ACTION_RE =
  /\b(?:read|inspect|search|find|list|show|open|edit|modify|patch|write|create|delete|rename|move|refactor|implement|fix|debug|test|typecheck|lint|build|run|execute|commit|diff|grep|rg|cat|sed|install|reinstall|uninstall|update|upgrade|wire(?:\s?up)?|integrate|register|hook(?:\s?up)?|configure|enable|add|npm|pnpm|yarn|npx|pip|pipx|apt|apt-get|brew|sudo|git)\b/i

const LOCAL_TARGET_RE =
  /\b(?:repo|repository|codebase|project|source|filesystem|files?|folders?|directories?|path|workspace|working folder|selected folder|terminal|shell|command|app|ui|frontend|component|src|package\.json|tsconfig|vite|electron|react|typescript|packages?|dependenc(?:y|ies)|deps?|tool|tooling|librar(?:y|ies)|modules?|cli|binar(?:y|ies))\b/i

const EXPLICIT_LOCAL_SCOPE_RE =
  /\b(?:this|the|current|selected)\s+(?:repo|repository|codebase|workspace|project|folder)\b|\b(?:in|inside|from|under)\s+(?:this|the|current|selected)\s+(?:repo|repository|codebase|workspace|project|folder)\b/i

// Installing/updating a tool, package, or repo is always local shell work, even
// when the target is a bare package name no vocabulary list would match. Kept
// narrow so plain English like "update me on the news" does not match: an
// install verb must sit next to a software-ish object, or be a real command form.
const INSTALL_INTENT_RE =
  /\b(?:re)?install\b|\buninstall\b|\b(?:update|upgrade|set\s?up|add|bump)\s+(?:the\s+|a\s+|my\s+)?(?:\S+\s+)?(?:packages?|dependenc(?:y|ies)|deps?|modules?|librar(?:y|ies)|tool(?:s|ing)?|cli|binar(?:y|ies)|version|electron|react|typescript|node|python|npm|pip)\b|\b(?:npm|pnpm|yarn|npx|pip|pipx|apt|apt-get|brew|cargo|go)\s+(?:install|add|get|i|upgrade|update)\b|\bgit\s+clone\b/i

/** True only when the user's words explicitly refer to the currently open page. */
export function shouldAttachActivePageContext(text: string): boolean {
  return ACTIVE_PAGE_CONTEXT_RE.test(text) || ACTIVE_PAGE_ACTION_RE.test(text)
}

/** True for short implicit follow-ups after a page-grounded assistant turn. */
export function shouldContinueActivePageContext(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 140) return false
  if (shouldAttachActivePageContext(t)) return true
  if (URL_RE.test(t) || WEB_SEARCH_RE.test(t) || shouldUseWorkspaceContext(t)) return false
  return ACTIVE_PAGE_FOLLOWUP_RE.test(t)
}

/**
 * True for a bare affirmative/continuation ("yes", "do it", "go ahead", "wire it
 * up") that carries NO routing signal of its own. Such a turn should inherit the
 * previous turn's tool profile instead of collapsing to conversation-only — the
 * user is approving the action the assistant just proposed, not starting a new
 * kind of task. Reuses the same follow-up vocabulary as the active-page path.
 */
export function isBareContinuation(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 140) return false
  // If the message routes on its own merits, it is not a bare continuation.
  if (URL_RE.test(t) || WEB_SEARCH_RE.test(t) || shouldUseWorkspaceContext(t)) return false
  if (BROWSER_CONTROL_RE.test(t)) return false
  return ACTIVE_PAGE_FOLLOWUP_RE.test(t) || /^\s*(?:do it|go ahead|wire it up|set it up|proceed|continue|go for it)\b/i.test(t)
}

/** True when browser/search tools should be available for this turn. */
export function shouldUseDirectBrowserTools(text: string): boolean {
  return shouldAttachActivePageContext(text) || URL_RE.test(text) || BROWSER_CONTROL_RE.test(text)
}

/** True when off-page web research/search tools should be available for this turn. */
export function shouldUseWebResearchTools(text: string): boolean {
  return !LOCAL_SEARCH_RE.test(text) && WEB_SEARCH_RE.test(text)
}

/** True when browser/search tools should be available for this turn. */
export function shouldUseBrowserTools(text: string): boolean {
  return shouldUseDirectBrowserTools(text) || shouldUseWebResearchTools(text)
}

/** True when the selected folder should be treated as relevant turn context. */
export function shouldUseWorkspaceContext(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (LOCAL_PATH_RE.test(t)) return true
  if (EXPLICIT_LOCAL_SCOPE_RE.test(t)) return true
  if (INSTALL_INTENT_RE.test(t)) return true
  if (WEB_SEARCH_RE.test(t)) return false
  return LOCAL_ACTION_RE.test(t) && LOCAL_TARGET_RE.test(t)
}

export type RoutingDecisionReason =
  | 'active-page-reference'
  | 'browser-action'
  | 'active-page-followup'
  | 'no-active-page-available'
  | 'explicit-local-scope'
  | 'local-action-target'
  | 'local-path'
  | 'no-active-page-reference'
  | 'no-local-intent'
  | 'no-selected-folder'
  | 'selected-folder'
  | 'web-docs-or-research'

export interface RoutingDecision {
  included: boolean
  reason: RoutingDecisionReason
  detail?: string
}

/** Explain why the active page was or was not attached as model context. */
export function explainActivePageContext(
  text: string,
  hasAttachedPageContext: boolean,
  continuedFromPreviousTurn = false
): RoutingDecision {
  if (ACTIVE_PAGE_CONTEXT_RE.test(text)) {
    return {
      included: hasAttachedPageContext,
      reason: hasAttachedPageContext ? 'active-page-reference' : 'no-active-page-available'
    }
  }
  if (ACTIVE_PAGE_ACTION_RE.test(text)) {
    return {
      included: hasAttachedPageContext,
      reason: hasAttachedPageContext ? 'browser-action' : 'no-active-page-available'
    }
  }
  if (continuedFromPreviousTurn) {
    return {
      included: hasAttachedPageContext,
      reason: hasAttachedPageContext ? 'active-page-followup' : 'no-active-page-available'
    }
  }
  return { included: false, reason: 'no-active-page-reference' }
}

/** Explain why the selected folder should or should not be included in model context. */
export function explainWorkspaceContext(text: string, hasSelectedFolder: boolean): RoutingDecision {
  const t = text.trim()
  if (!hasSelectedFolder) return { included: false, reason: 'no-selected-folder' }
  if (!t) return { included: false, reason: 'no-local-intent' }
  if (LOCAL_PATH_RE.test(t)) return { included: true, reason: 'local-path' }
  if (EXPLICIT_LOCAL_SCOPE_RE.test(t)) return { included: true, reason: 'explicit-local-scope' }
  if (WEB_SEARCH_RE.test(t)) return { included: false, reason: 'web-docs-or-research' }
  if (LOCAL_ACTION_RE.test(t) && LOCAL_TARGET_RE.test(t)) {
    return { included: true, reason: 'local-action-target' }
  }
  return { included: false, reason: 'no-local-intent' }
}

/** ---- Model call audit ---- */

export type ModelCallStatus = 'running' | 'ok' | 'error'

export interface ModelCallRecord {
  id: string
  requestId?: string
  conversationId?: string | null
  provider: Provider
  modelId: string
  stage: string
  status: ModelCallStatus
  startedAt: number
  endedAt?: number
  latencyMs?: number
  inputChars: number
  outputChars: number
  inputTokensEstimate: number
  outputTokensEstimate: number
  inputTokensActual?: number
  outputTokensActual?: number
  cachedInputTokensActual?: number
  reasoningOutputTokensActual?: number
  error?: string
}

export type ModelCallEvent =
  | { type: 'started'; record: ModelCallRecord }
  | { type: 'updated'; record: ModelCallRecord }

/** ---- Chat persistence ---- */

/**
 * Which side a conversation belongs to. Each saved chat is sticky to one side:
 * it restores there on launch, only shows up in that side's history modal, and
 * never migrates because some other side happened to update last. Legacy convs
 * persisted before this field existed are treated as `'left'` (the only side
 * that was ever intended to persist), so existing history stays put.
 */
export type ChatPanelSide = 'left' | 'right'

/** A single tool invocation, persisted alongside its assistant turn. */
export interface StoredToolActivity {
  callId: string
  tool: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  startedAt?: number
  endedAt?: number
  durationMs?: number
  preview?: string
}

export type ContractTraceProfile =
  | 'conversation'
  | 'browser'
  | 'filesystem'
  | 'research'
  | 'full'
  | 'codex'

export interface ContractTrace {
  profile: ContractTraceProfile
  tools: string[]
  activePage?: RoutingDecision
  workspace?: RoutingDecision
  codexCwd?: RoutingDecision
  inputs?: {
    selectedFolder?: string
    activePageContext?: string
    codexCwd?: string
  }
}

export interface StoredProgressStepPart extends PipelineProgressStep {
  kind: 'progress_step'
}

export type LoopPhase =
  | 'inspect'
  | 'recon'
  | 'plan'
  | 'act'
  | 'validate'
  | 'decide'
  | 'handoff'
  | 'done'

export type LoopStateEventName =
  | 'task_started'
  | 'phase_changed'
  | 'iteration_started'
  | 'iteration_completed'
  | 'checkpoint_created'
  | 'task_paused'
  | 'task_blocked'
  | 'task_completed'
  | 'task_aborted'

export interface LoopStateTrace {
  taskId: string
  event: LoopStateEventName
  phase: LoopPhase
  iteration: number
  reason?: string
  summary?: string
}

export interface StoredLoopStatePart extends LoopStateTrace {
  kind: 'loop_state'
}

export type CapabilityName =
  | 'repo_overview'
  | 'search_repo'
  | 'read_spans'
  | 'research_dossier'
  | 'verify_change'
  | 'recall_task'

export type CapabilityActivityEventName =
  | 'capability_requested'
  | 'capability_started'
  | 'capability_progress'
  | 'capability_completed'
  | 'capability_failed'
  | 'capability_cache_hit'

export interface CapabilityActivityTrace {
  callId: string
  capability: CapabilityName
  event: CapabilityActivityEventName
  service?: string
  summary?: string
  cached?: boolean
  artifactId?: string
  durationMs?: number
  cacheHitCount?: number
  cacheMissCount?: number
  cacheSize?: number
  cacheLimit?: number
  cacheTtlMs?: number
  cacheExpired?: number
  cacheEvictions?: number
}

export interface StoredCapabilityActivityPart extends CapabilityActivityTrace {
  kind: 'capability_activity'
}

export type VerificationStatus = 'pass' | 'fail' | 'partial' | 'blocked'
export type VerificationEventName =
  | 'verification_started'
  | 'verification_check_started'
  | 'verification_check_finished'
  | 'verification_passed'
  | 'verification_failed'
  | 'verification_blocked'

export interface VerificationStateTrace {
  event: VerificationEventName
  check?: string
  status?: VerificationStatus
  summary?: string
  rawLogArtifactId?: string
}

export interface StoredVerificationStatePart extends VerificationStateTrace {
  kind: 'verification_state'
}

export type TaskMemoryScope = 'task' | 'conversation' | 'workspace'
export type TaskMemoryEventName =
  | 'memory_read'
  | 'memory_write'
  | 'memory_compacted'
  | 'memory_linked_artifact'

export interface TaskMemoryTrace {
  event: TaskMemoryEventName
  scope: TaskMemoryScope
  keys?: string[]
  summary?: string
  artifactId?: string
}

export interface StoredTaskMemoryPart extends TaskMemoryTrace {
  kind: 'task_memory'
}

export type StoredMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: StoredToolActivity }
  | { kind: 'contract'; trace: ContractTrace }
  | StoredLoopStatePart
  | StoredCapabilityActivityPart
  | StoredVerificationStatePart
  | StoredTaskMemoryPart
  | StoredProgressStepPart

/** A persisted chat message: the full renderer-visible shape. */
export interface StoredMessage {
  /** Stable renderer id used to route live stream events to this exact turn. */
  id?: string
  role: 'user' | 'assistant'
  text: string
  /** Context line shown under a user message (the attached page). */
  meta?: string
  /** Ordered prose/tool/contract fragments for an assistant turn. */
  parts?: StoredMessagePart[]
  /** Execution calls made while producing this assistant turn. */
  tools?: StoredToolActivity[]
  images?: string[]
}

/** One saved conversation. Persisted to disk in the main process. */
export interface Conversation {
  id: string
  /** Derived from the first user message, or model-generated (see titleLocked). */
  title: string
  /** Compact catch-up text shown before reading full turns. */
  summary?: string
  /** True once a model-generated title is set, so it isn't re-derived on save. */
  titleLocked?: boolean
  /** Provider thread used to reopen this same saved chat after app restart. */
  codexThreadId?: string | null
  /** Previous conversation this fresh chat continues from, if any. */
  continuesFromId?: string | null
  /** Which dock side owns this chat; sticky once set (defaults to 'left' on load). */
  panel?: ChatPanelSide
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
}

/** Lightweight conversation header for the history list (no messages). */
export interface ConversationMeta {
  id: string
  title: string
  summary?: string
  createdAt: number
  updatedAt: number
  continuesFromId?: string | null
  panel?: ChatPanelSide
}

/** One explicit past-chat search hit. */
export interface ConversationSearchHit {
  conversationId: string
  title: string
  summary?: string
  createdAt: number
  updatedAt: number
  continuesFromId?: string | null
  panel?: ChatPanelSide
  role: 'user' | 'assistant'
  messageIndex: number
  excerpt: string
  score: number
}

/** A request to stream a completion. */
export interface ChatRequest {
  requestId: string
  /** Renderer id for the assistant message this request will fill. */
  assistantMessageId?: string
  modelId: string
  messages: ChatMessage[]
  /**
   * Internal routing hint. The renderer no longer exposes Ask/Agent as a user
   * decision; attached-page turns are routed through the browser-capable path.
   */
  mode?: 'ask' | 'agent'
  /** The tab the browser-capable route acts on (the attached/active page). */
  tabId?: string | null
  /**
   * The conversation this request belongs to. The renderer sends only a small
   * recent slice in `messages` (to keep tokens low); the full transcript lives
   * on disk under this id, and the model can pull older turns on demand via the
   * recall_history tool. Absent means no deeper history is reachable for the turn.
   */
  conversationId?: string | null
  /** Renderer-derived context continuity hints that are not user-visible text. */
  contextHints?: {
    activePageFollowup?: boolean
  }
}

/** OpenAI TTS voices (audible replies feature). */
export const TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse'
] as const
export type TtsVoice = (typeof TTS_VOICES)[number]

/**
 * Short, human-readable hints for each voice. APPROXIMATE — OpenAI doesn't
 * publish official gender/character metadata and may retune a voice, so these
 * are a scanning aid, not a guarantee. Use the preview button to hear the real
 * voice before committing.
 */
export const TTS_VOICE_HINTS: Record<TtsVoice, string> = {
  alloy: 'neutral',
  ash: 'warm, male',
  ballad: 'soft, male',
  coral: 'bright, female',
  echo: 'crisp, male',
  fable: 'expressive, British',
  nova: 'bright, female',
  onyx: 'deep, male',
  sage: 'calm, female',
  shimmer: 'soft, female',
  verse: 'versatile, male'
}

/** Result of one text-to-speech request (audible replies feature). */
export type TtsResult =
  | { ok: true; audio: string; format: 'mp3' }
  | { ok: false; reason: 'no-key' | 'error'; message?: string }

export type ProgressStepStatus = 'planned' | 'running' | 'passed' | 'replanned' | 'failed' | 'aborted' | 'skipped'

export interface PipelineProgressStep {
  step: number
  total?: number
  status: ProgressStepStatus
  title: string
  detail?: string
}

/** Streamed chunk events pushed main -> renderer, keyed by requestId. */
export type ChatStreamEvent =
  | { requestId: string; assistantMessageId?: string; type: 'delta'; text: string }
  | { requestId: string; assistantMessageId?: string; type: 'done' }
  | { requestId: string; assistantMessageId?: string; type: 'error'; message: string }
  | {
      requestId: string
      assistantMessageId?: string
      type: 'loop_state'
      taskId: string
      event: LoopStateEventName
      phase: LoopPhase
      iteration: number
      reason?: string
      summary?: string
    }
  | {
      requestId: string
      assistantMessageId?: string
      type: 'capability_activity'
      callId: string
      capability: CapabilityName
      event: CapabilityActivityEventName
      service?: string
      summary?: string
      cached?: boolean
      artifactId?: string
      durationMs?: number
      cacheHitCount?: number
      cacheMissCount?: number
      cacheSize?: number
      cacheLimit?: number
      cacheTtlMs?: number
      cacheExpired?: number
      cacheEvictions?: number
    }
  | {
      requestId: string
      assistantMessageId?: string
      type: 'verification_state'
      event: VerificationEventName
      check?: string
      status?: VerificationStatus
      summary?: string
      rawLogArtifactId?: string
    }
  | {
      requestId: string
      assistantMessageId?: string
      type: 'task_memory'
      event: TaskMemoryEventName
      scope: TaskMemoryScope
      keys?: string[]
      summary?: string
      artifactId?: string
    }
  /** A compact execution contract for this assistant turn. */
  | {
      requestId: string
      assistantMessageId?: string
      type: 'contract_trace'
      profile: ContractTraceProfile
      tools: string[]
      activePage?: RoutingDecision
      workspace?: RoutingDecision
      codexCwd?: RoutingDecision
      inputs?: ContractTrace['inputs']
    }
  /** The model invoked a browser tool, surfaced live so the user sees it. */
  | {
      requestId: string
      assistantMessageId?: string
      type: 'tool_call'
      tool: string
      args: unknown
      callId: string
      startedAt?: number
    }
  /** A tool finished; `ok` + a short preview of what it returned. */
  | {
      requestId: string
      assistantMessageId?: string
      type: 'tool_result'
      callId: string
      ok: boolean
      endedAt?: number
      durationMs?: number
      preview: string
    }
  | ({ requestId: string; assistantMessageId?: string; type: 'progress_step' } & PipelineProgressStep)

/**
 * Which providers are usable (never the keys themselves).
 * - anthropic/google/grok: true once an API key is configured.
 * - codex: true once the codex CLI is installed AND logged in.
 */
export interface KeyStatus {
  anthropic: boolean
  google: boolean
  codex: boolean
  /** OpenAI key, used only for text-to-speech (audible replies), not chat. */
  openai: boolean
  /** xAI (Grok) key, used for chat. */
  grok: boolean
}

/** Status of the local Codex CLI / app-server. */
export interface CodexStatus {
  /** `codex` binary found on PATH (or via GLADDIS_CODEX_BIN). */
  installed: boolean
  /** Logged in (ChatGPT OAuth or API key), required to run turns. */
  authenticated: boolean
  /** "chatgpt" | "apikey" | null. */
  authMethod: string | null
  /** Resolved codex version string, when known. */
  version: string | null
  /** Human-readable reason when unusable (not installed / not logged in). */
  detail: string | null
}

/**
 * Working directory for Codex turns, chosen by the user. The folder is only
 * Codex's starting cwd. It never narrows permissions: Codex always runs with
 * unrestricted read/write access as the OS user.
 */
export interface CodexWorkspace {
  /** Absolute starting cwd for Codex, or null to start from the user's home. */
  folder: string | null
}

/**
 * The folder gladdis works from app-wide: the root that relative file paths in
 * the agent's filesystem tools resolve against.
 */
export interface Workspace {
  /** Absolute path gladdis works from, or null for no pinned root. */
  folder: string | null
}

export type { ModelOption, Provider }
