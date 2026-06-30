import type { ChatStore } from '../ChatStore'
import type { Conversation, ConversationMeta } from '../../../../shared/types'
import type { ToolContext, ToolOutcome } from '../browserTools'
import {
  isKnownToolGroup,
  isKnownToolName,
  normalizeRequestedGroups,
  normalizeRequestedTools,
  toolGroupNames
} from '../agentTools'
import { cap } from './toolUtils'

export interface HistoryToolsDeps {
  chats: ChatStore
}

const REQUEST_TOOLS_ERROR =
  'request_tools: provide {"group":"filesystem|browser|research"} or {"tools":[...tool_names...]}.'

/**
 * Pull in additional tools at runtime by group name. Lets a model start a
 * turn on the lean conversation profile and escalate as needed without us
 * having to ship every tool every turn.
 */
export async function runRequestTools(
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const requestedGroups = normalizeRequestedGroups(args.group)
  const requestedTools = normalizeRequestedTools(args.tools)
  const unknownGroups = requestedGroups.filter((group) => !isKnownToolGroup(group))
  const groupNames = requestedGroups.filter((group) => !unknownGroups.includes(group)).flatMap((group) => toolGroupNames(group))
  const unknownTools = requestedTools.filter((tool) => !isKnownToolName(tool))

  if (unknownTools.length > 0) {
    return {
      ok: false,
      text: `request_tools: unknown tool(s): ${unknownTools.join(', ')}.`
    }
  }

  const names = Array.from(new Set([...groupNames, ...requestedTools]))
  if (names.length === 0) {
    if (requestedGroups.length > 0 && unknownGroups.length > 0) {
      return { ok: false, text: `request_tools: unknown group "${requestedGroups[0]}". Use filesystem, browser, or research.` }
    }
    return { ok: false, text: REQUEST_TOOLS_ERROR }
  }
  const granted = (ctx.grantedTools ??= new Set<string>())
  for (const name of names) granted.add(name)
  return {
    ok: true,
    text: `Granted ${groupNameLabel(requestedGroups, requestedTools)} for this turn: ${names.join(', ')}. Call them now to continue.`
  }
}

function groupNameLabel(groupNames: string[], toolNames: string[]): string {
  if (groupNames.length > 0 && toolNames.length > 0) return 'groups/tools'
  if (toolNames.length > 0) return 'tools'
  return 'group'
}

/**
 * Pull earlier context for the current conversation chain (or any saved
 * conversation by id). Three modes:
 *  • `tool_call_id` — replay a verbatim tool result from this same request
 *  • `conversation_id` — the full transcript of a specific saved chat
 *  • default — search/list across the current conversation lineage (or
 *    everything when scope:'all')
 */
export function runRecallHistory(
  deps: HistoryToolsDeps,
  args: Record<string, any>,
  ctx: ToolContext
): ToolOutcome {
  const toolCallId = args.tool_call_id ? String(args.tool_call_id) : null
  if (toolCallId) {
    const full = ctx.fullResults?.get(toolCallId)
    if (full != null) {
      const resultText = cap(full, 20_000)
      return {
        ok: true,
        text: resultText,
        structuredContent: {
          mode: 'tool_call_result',
          toolCallId,
          resultText
        }
      }
    }
    return { ok: false, text: `No tool result found for id "${toolCallId}" in this request.` }
  }

  const scope = args.scope === 'all' ? 'all' : 'conversation'
  const query = args.query ? String(args.query).trim() : ''
  const conversationId = args.conversation_id ? String(args.conversation_id).trim() : ''

  if (conversationId) {
    const conv = deps.chats.get(conversationId)
    if (!conv) return { ok: false, text: `No saved Gladdis conversation found for id "${conversationId}".` }
    const transcript = serializeTranscript(conv)
    const createdAt = formatConversationDate(conv.createdAt)
    const updatedAt = formatConversationDate(conv.updatedAt)
    const resultText = cap(
      `Gladdis conversation "${conv.title}"\n` +
      `id: ${conv.id}\n` +
      `created: ${createdAt}\n` +
      `updated: ${updatedAt}\n\n` +
      conversationTranscript(conv),
      30_000
    )
    return {
      ok: true,
      text: resultText,
      structuredContent: {
        mode: 'conversation_transcript',
        scope,
        conversationId: conv.id,
        title: conv.title,
        createdAt,
        updatedAt,
        summary: conversationSummary(conv),
        transcript
      }
    }
  }

  if (scope === 'all') {
    if (!query) {
      const recent = deps.chats.list().slice(0, 8)
      if (recent.length === 0) return { ok: true, text: 'No saved Gladdis conversations are stored yet.' }
      const body = recent.map((conv, index) =>
        `${index + 1}. ${conv.title}\n` +
        `   id: ${conv.id} | updated: ${formatConversationDate(conv.updatedAt)}\n` +
        `   summary: ${conversationMetaSummary(conv)}`
      ).join('\n\n')
      const conversations = recent.map((conv) => ({
        id: conv.id,
        title: conv.title,
        updatedAt: formatConversationDate(conv.updatedAt),
        summary: conversationMetaSummary(conv)
      }))
      return {
        ok: true,
        text:
          'Recent saved Gladdis conversations. ' +
          'Use conversation_id to read the full saved chat only if the summary is not enough.\n\n' +
          body,
        structuredContent: {
          mode: 'saved_conversation_list',
          scope,
          totalConversations: conversations.length,
          conversations
        }
      }
    }
    const hits = deps.chats.search(query, 8)
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
        body,
      structuredContent: {
        mode: 'saved_conversation_search',
        scope,
        query,
        hitCount: hits.length,
        matches: hits.map((hit) => ({
          conversationId: hit.conversationId,
          title: hit.title,
          updatedAt: formatConversationDate(hit.updatedAt),
          summary: hit.summary || '(no summary yet)',
          role: hit.role,
          messageIndex: hit.messageIndex + 1,
          excerpt: hit.excerpt
        }))
      }
    }
  }

  if (!ctx.conversationId) {
    return { ok: false, text: 'No conversation context is available to recall from.' }
  }
  const conversations = deps.chats.lineage(ctx.conversationId)
  if (conversations.length <= 1) {
    const previous = deps.chats.previousConversation(ctx.conversationId)
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
    const chainNote = conversations.length > 1 ? ` across ${conversations.length} linked chats` : ''
    return {
      ok: true,
      text: cap(
        `Brief conversation overview${chainNote}. ` +
        `Use conversation_id to read a full saved chat, or query for exact matching turns.\n\n${sections.join('\n\n')}`,
        8_000
      ),
      structuredContent: {
        mode: 'lineage_overview',
        scope,
        totalConversations: conversations.length,
        conversations: conversations.map((conv, convIndex) => ({
          id: conv.id,
          title: conv.title,
          createdAt: formatConversationDate(conv.createdAt),
          updatedAt: formatConversationDate(conv.updatedAt),
          summary: conversationSummary(conv) || '(no summary yet)',
          source: convIndex === 0 ? 'current chat' : 'previous chat',
          messageCount: conv.messages.length
        }))
      }
    }
  }

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
  return {
    ok: true,
    text: cap(`${hits.length} matching turn(s):\n\n${body}`, 30_000),
    structuredContent: {
      mode: 'lineage_search',
      scope,
      query,
      hitCount: hits.length,
      matches: hits.map(({ conv, convIndex, m, i }) => ({
        conversationId: conv.id,
        title: conv.title,
        source: convIndex === 0 ? 'current chat' : `continued from "${conv.title}"`,
        role: m.role,
        messageIndex: i + 1,
        text: m.text,
        tools: serializeToolList(m.tools)
      }))
    }
  }
}

// ── Conversation formatting helpers ─────────────────────────────────────────

function compactTurn(text: string, max = 180): string {
  const snippet = text.replace(/\s+/g, ' ').trim()
  return snippet.length > max ? snippet.slice(0, max) + '...' : snippet
}

function formatConversationDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function conversationSummary(conv: Conversation): string {
  if (conv.summary?.trim()) return conv.summary.trim()
  return conv.messages
    .filter((m) => m.text.trim())
    .slice(0, 6)
    .map((m) => `${m.role}: ${compactTurn(m.text)}`)
    .join('\n')
}

function conversationTranscript(conv: Conversation): string {
  return conv.messages
    .map((m, i) => {
      const tools = (m.tools ?? [])
        .map((t) => `  · ${t.tool} (${t.status})${t.preview ? `: ${t.preview}` : ''}`)
        .join('\n')
      return `#${i + 1} ${m.role}:\n${m.text}${tools ? `\n${tools}` : ''}`
    })
    .join('\n\n')
}

function serializeTranscript(conv: Conversation): Array<Record<string, unknown>> {
  return conv.messages.map((message, index) => ({
    role: message.role,
    text: message.text,
    index: index + 1,
    ...(message.tools?.length ? { tools: serializeToolList(message.tools) } : {})
  }))
}

function serializeToolList(
  tools: Conversation['messages'][number]['tools'] | undefined
): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => ({
    tool: tool.tool,
    status: tool.status,
    ...(tool.preview ? { preview: tool.preview } : {})
  }))
}

function conversationMetaSummary(conv: ConversationMeta): string {
  return conv.summary?.trim() || '(no summary yet)'
}
