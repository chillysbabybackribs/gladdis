import type {
  ChatRequest,
  ContractTrace,
  ModelOption,
  RoutingDecision
} from '../../../shared/types'
import {
  explainActivePageContext,
  explainWorkspaceContext,
  shouldAttachActivePageContext,
  shouldUseBrowserTools,
  shouldUseWorkspaceContext
} from '../../../shared/types'
import { AGENT_TOOLS } from './agentTools'
import type { AgentToolSurface } from './AgentConfigurationService'
import { stripActivePagePreamble } from './routing'

export interface TurnContextPolicy {
  actionableText: string
  activePageContextLabel: string | null
  hadActivePagePreamble: boolean
  activePageIntent: boolean
  activePageFollowup: boolean
  browserIntent: boolean
  workspaceIntent: boolean
  profile: AgentToolSurface
}

export interface BuildTraceOptions {
  provider: ModelOption['provider']
  profile: AgentToolSurface
  actionableText: string
  selectedFolder: string | null
  attachedActivePageContext: boolean
  activePageContextLabel: string | null
  activePageFollowup?: boolean
}

export function resolveTurnContextPolicy(
  req: ChatRequest,
  options?: { hasWorkspaceFolder?: boolean }
): TurnContextPolicy {
  const lastMsg = req.messages[req.messages.length - 1]
  const userText = lastMsg && lastMsg.role === 'user' ? lastMsg.content.trim() : ''
  const activePageContextLabel = extractActivePageContextLabel(userText)
  const actionableText = stripActivePagePreamble(userText)
  const hadActivePagePreamble = userText !== actionableText
  const activePageFollowup = req.contextHints?.activePageFollowup === true
  const activePageIntent = shouldAttachActivePageContext(actionableText) || activePageFollowup
  const browserIntent = shouldUseBrowserTools(actionableText) || activePageFollowup

  return {
    actionableText,
    activePageContextLabel,
    hadActivePagePreamble,
    activePageIntent,
    activePageFollowup,
    browserIntent,
    workspaceIntent: shouldUseWorkspaceContext(actionableText),
    // This is only the initial policy placeholder. The real routed surface is
    // chosen later in AgentConfigurationService.agentToolProfile.
    profile: { name: 'full', tools: [...AGENT_TOOLS] }
  }
}

/**
 * True when Cursor Agent should get the Gladdis HTTP MCP bridge for this turn.
 *
 * Only turn the bridge on when the user is actually asking for browser/page/web
 * work. This keeps plain repo/code chat aligned with the tighter OpenAI path
 * instead of always exposing browser MCP tools.
 */
export function shouldEnableCursorMcpBridge(policy: TurnContextPolicy): boolean {
  return policy.browserIntent || policy.activePageIntent || policy.hadActivePagePreamble
}

export function stripStaleActivePageContext(req: ChatRequest, policy: TurnContextPolicy): void {
  const lastMsg = req.messages[req.messages.length - 1]
  if (lastMsg?.role === 'user' && policy.hadActivePagePreamble && !policy.activePageIntent) {
    lastMsg.content = policy.actionableText
  }
}

export function buildContractTrace(options: BuildTraceOptions): ContractTrace {
  const workspace = explainWorkspaceContext(options.actionableText, Boolean(options.selectedFolder))
  if (workspace.included && options.selectedFolder) workspace.detail = options.selectedFolder
  const codexCwd = buildCodexCwdDecision(options.provider, workspace, options.selectedFolder)
  const traceProfile = options.provider === 'codex'
    ? 'codex'
    : traceProfileForTools(options.profile.tools.map((tool) => tool.name))

  return {
    profile: traceProfile,
    tools: options.profile.tools.map((tool) => tool.name),
    activePage: explainActivePageContext(
      options.actionableText,
      options.attachedActivePageContext,
      options.activePageFollowup === true
    ),
    workspace,
    codexCwd,
    inputs: {
      selectedFolder: options.selectedFolder ?? undefined,
      activePageContext: options.attachedActivePageContext
        ? options.activePageContextLabel ?? undefined
        : undefined,
      codexCwd: codexCwd?.detail
    }
  }
}

function traceProfileForTools(toolNames: string[]): ContractTrace['profile'] {
  const names = new Set(toolNames)
  const browser =
    names.has('search') ||
    names.has('navigate') ||
    names.has('grep_page') ||
    names.has('read_page') ||
    names.has('read_a11y') ||
    names.has('act')
  const filesystem =
    names.has('search_files') ||
    names.has('read_file') ||
    names.has('edit_file') ||
    names.has('write_file') ||
    names.has('run_command')

  if (browser && filesystem) return 'full'
  if (browser) return 'browser'
  if (filesystem) return 'filesystem'
  return 'conversation'
}

function extractActivePageContextLabel(text: string): string | null {
  const match = text.trim().match(/^\[Active page:\s*([^\]]+)\]\s*\n{2,}/i)
  return match?.[1]?.trim() || null
}

function buildCodexCwdDecision(
  provider: ModelOption['provider'],
  workspace: RoutingDecision,
  selectedFolder: string | null
): RoutingDecision | undefined {
  if (provider !== 'codex') return undefined
  if (selectedFolder) {
    return { included: true, reason: 'selected-folder', detail: selectedFolder }
  }
  return {
    ...workspace,
    included: false,
    detail: 'home'
  }
}
