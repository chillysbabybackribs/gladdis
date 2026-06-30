import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage, SavedAgent, TabInfo } from '../../../shared/types'
import {
  MODELS,
  shouldAttachActivePageContext,
  shouldContinueActivePageContext
} from '../../../shared/types'
import { Composer, type ComposerInterjectionMode, type ComposerSubmit } from './Composer'
import { TokenCounter } from './TokenCounter'
import { ChatSettingsModal } from './ChatSettingsModal'
import { useTts, useTtsSettings } from '../hooks/useTts'
import { useStreamConsumer } from '../hooks/useStreamConsumer'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { useAuditRecords } from '../hooks/useAuditRecords'
import { useEnvironmentStatus } from '../hooks/useEnvironmentStatus'
import { useConversationPersistence } from '../hooks/useConversationPersistence'
import { previousTurnAttachedActivePage } from '../lib/chatTurnContext'
import type { Message } from './chatTypes'
import { appendText } from './chatTypes'
import { ChatMessageList } from './chat-parts/ChatMessageList'
import { ChatSettingsButton, TurnControls } from './chat-parts/TurnControls'

let reqCounter = 0
const newRequestId = () => `req-${Date.now()}-${reqCounter++}`

let msgCounter = 0
const newMessageId = () => `msg-${Date.now()}-${msgCounter++}`

let convCounter = 0
const newConversationId = () => `conv-${Date.now()}-${convCounter++}`

export type PanelId = 'left' | 'right'

const modelKey = (panelId: PanelId) => `gladdis:model:${panelId}`
const agentKey = (panelId: PanelId) => `gladdis:agent:${panelId}`
const audioKey = (panelId: PanelId) => `gladdis:audio:${panelId}`

const RECENT_TURNS = 8

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`
}

export function ChatPanel({
  panelId = 'left',
  zoom = 1,
  footerSlot = null,
  footerTokenSlot = null,
  onCreateAgent = () => {},
  onEditAgent = () => {}
}: {
  panelId?: PanelId
  zoom?: number
  footerSlot?: HTMLElement | null
  footerTokenSlot?: HTMLElement | null
  onCreateAgent?: () => void
  onEditAgent?: (agent: SavedAgent) => void
} = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [convId, setConvId] = useState<string>(() => newConversationId())
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'history' | 'keys' | 'calls'>('history')
  const [historyRev, setHistoryRev] = useState(0)
  const convCreatedAt = useRef<number>(Date.now())
  const continuesFromId = useRef<string | null>(null)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string>(() => {
    try {
      // Trust the saved selection verbatim. We deliberately do NOT validate it
      // against the static MODELS list: the live catalog (esp. Codex CLI models)
      // carries ids that aren't in MODELS, and validating here would silently
      // reset the user's choice to MODELS[0] on every restart. MODELS[0] is only
      // a first-run placeholder for when nothing has ever been picked.
      return localStorage.getItem(modelKey(panelId)) || MODELS[0].id
    } catch {
      return MODELS[0].id
    }
  })
  const [agents, setAgents] = useState<SavedAgent[]>([])
  const [agentId, setAgentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(agentKey(panelId))
    } catch {
      return null
    }
  })
  const auditRecords = useAuditRecords()
  const { keyStatus, setKeyStatus, codexStatus, claudeCodeStatus, models, workspace, pickWorkspace } =
    useEnvironmentStatus()
  const [streaming, setStreaming] = useState(false)
  const [paused, setPaused] = useState(false)
  const [audioOn, setAudioOn] = useState(() => {
    try {
      return localStorage.getItem(audioKey(panelId)) === '1'
    } catch {
      return false
    }
  })
  const { voice, speed, setVoice: persistVoice, setSpeed: persistSpeed } = useTtsSettings()
  const notifyTtsError = (message: string) => {
    setMessages((msgs) => {
      const out = msgs.slice()
      const last = out[out.length - 1]
      if (last?.role !== 'assistant') return msgs
      const note = `\n\n> 🔇 ${message}`
      out[out.length - 1] = {
        ...last,
        text: last.text + note,
        parts: appendText(last.parts ?? [], note)
      }
      return out
    })
  }
  const tts = useTts(audioOn, { voice, speed, onError: notifyTtsError })
  const ttsRef = useRef(tts)
  ttsRef.current = tts
  const activeReq = useRef<string | null>(null)
  const activeAssistantMessageId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScroll = useAutoScroll(scrollRef)
  const convIdRef = useRef(convId)
  const messagesRef = useRef(messages)
  const modelIdRef = useRef(modelId)

  convIdRef.current = convId
  messagesRef.current = messages
  modelIdRef.current = modelId

  const persistence = useConversationPersistence({
    panel: panelId,
    convIdRef,
    messagesRef,
    modelIdRef,
    createdAtRef: convCreatedAt,
    continuesFromIdRef: continuesFromId,
    streaming,
    messages,
    convId,
    bumpHistoryRev: () => setHistoryRev((r) => r + 1)
  })
  const {
    restoredRef,
    conversationSignature,
    lastSavedSignatureRef,
    buildConversation,
    persistConversation,
    flushPersist
  } = persistence

  useEffect(() => {
    const off = window.gladdis.tabs.onUpdated(({ tabs: next, activeTabId }) => {
      setTabs(next)
      setActiveId(activeTabId)
    })
    void window.gladdis.tabs.list().then((t) => {
      setTabs(t)
      setActiveId(t.at(-1)?.id ?? null)
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.gladdis.agents.onUpdated((next) => setAgents(next))
    void window.gladdis.agents.list().then((next) => setAgents(next))
    return off
  }, [])

  useEffect(() => {
    if (!agentId) return
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) {
      if (agents.length > 0) persistAgent(null)
      return
    }
    const preferredModel = agent.runtimeModelId || agent.modelId
    if (modelIdRef.current !== preferredModel) persistModel(preferredModel)
    if (!models.some((model) => model.id === preferredModel) && models.some((model) => model.id === agent.modelId)) {
      persistModel(agent.modelId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, agents])

  // Restore each panel's own last-active conversation. lastActive is scoped
  // by panelId in the main process, so the left panel never steals a chat
  // that was last touched on the right (and vice versa) — chats are sticky
  // to whichever side they were created on.
  useEffect(() => {
    void (async () => {
      try {
        const id = await window.gladdis.chats.lastActive(panelId)
        const conv = id ? await window.gladdis.chats.get(id) : null
        if (conv && conv.messages.length) {
          setConvId(conv.id)
          convCreatedAt.current = conv.createdAt
          continuesFromId.current = conv.continuesFromId ?? null
          lastSavedSignatureRef.current = conversationSignature(
            conv.id,
            conv.createdAt,
            conv.messages as Message[],
            conv.continuesFromId ?? null
          )
          setMessages(conv.messages as Message[])
          // After the restored messages paint, anchor at the latest reply
          // instead of opening at the top of the transcript.
          requestAnimationFrame(() => autoScroll.scrollToBottom())
        }
      } finally {
        restoredRef.current = true
      }
    })()
    // autoScroll is stable for the lifetime of this panel; including it would
    // re-run this restore effect and double-load the conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId])

  useStreamConsumer({
    activeReq,
    activeAssistantMessageId,
    ttsRef,
    setMessages,
    setStreaming,
    setPaused,
    onCommit: autoScroll.scheduleScroll
  })

  const persistModel = (id: string) => {
    setModelId(id)
    try {
      localStorage.setItem(modelKey(panelId), id)
    } catch (e) {
      console.warn('Failed to save model to localStorage:', e)
    }
  }

  const persistAgent = (id: string | null) => {
    setAgentId(id)
    try {
      if (id) localStorage.setItem(agentKey(panelId), id)
      else localStorage.removeItem(agentKey(panelId))
    } catch (e) {
      console.warn('Failed to save agent to localStorage:', e)
    }
    const agent = id ? agents.find((candidate) => candidate.id === id) : null
    if (agent) persistModel(agent.runtimeModelId || agent.modelId)
  }

  const deleteAgent = (agent: SavedAgent) => {
    if (!window.confirm(`Delete agent "${agent.name}"?`)) return
    void window.gladdis.agents.delete(agent.id).then(() => {
      if (agentId === agent.id) persistAgent(null)
    })
  }

  // The native Agents menu ("Chat Left" / "Chat Right") selects agents per panel.
  // persistAgent is recreated each render; route through a ref so the listener
  // stays subscribed once and always calls the latest closure.
  const persistAgentRef = useRef(persistAgent)
  persistAgentRef.current = persistAgent
  useEffect(() => {
    return window.gladdis.app.onCommand((command) => {
      if (command.type === 'agents:select' && command.panel === panelId) {
        persistAgentRef.current(command.agentId)
      }
    })
  }, [panelId])

  const toggleAudio = () => {
    setAudioOn((on) => {
      const next = !on
      try {
        localStorage.setItem(audioKey(panelId), next ? '1' : '0')
      } catch (e) {
        console.warn('Failed to save audio state to localStorage:', e)
      }
      // Turning on without a key is a no-op that silently fails; nudge the
      // user to set the OpenAI key so they know why nothing is spoken.
      if (next && !keyStatus.openai) {
        setSettingsTab('keys')
        setShowSettings(true)
      }
      return next
    })
  }

  const onSubmit = ({ text }: ComposerSubmit) => {
    if (streaming) return

    const model = models.find((m) => m.id === modelId) ?? MODELS.find((m) => m.id === modelId)
    if (!model) return
    const usable =
      model.provider === 'codex'
        ? !!codexStatus?.installed && !!codexStatus?.authenticated
        : model.provider === 'claudecode'
          ? !!claudeCodeStatus?.installed && !!claudeCodeStatus?.authenticated
        : model.provider === 'anthropic'
          ? keyStatus.anthropic
          : model.provider === 'grok'
            ? keyStatus.grok
            : model.provider === 'openai'
              ? keyStatus.openai
              : keyStatus.google
    if (!usable) {
      setSettingsTab('keys')
      setShowSettings(true)
      return
    }

    const activeTab = tabs.find((t) => t.id === activeId) ?? null
    const selectedAgent = agentId ? agents.find((agent) => agent.id === agentId) ?? null : null
    const userMsg: Message = { role: 'user', text }
    const nextMessages: Message[] = [...messagesRef.current, userMsg]
    const prior: ChatMessage[] = messagesRef.current
      .slice(-RECENT_TURNS)
      .map((m) => ({ role: m.role, content: m.text, images: m.images }))
    const droppedTurns = messagesRef.current.length - prior.length
    if (droppedTurns > 0) {
      prior.unshift({
        role: 'user',
        content:
          `[${droppedTurns} earlier turn${droppedTurns === 1 ? '' : 's'} in this ` +
          `conversation are not shown above. Call recall_history to read them when needed.]`
      })
    }
    const activePageFollowup =
      previousTurnAttachedActivePage(messagesRef.current) && shouldContinueActivePageContext(text)
    const attachActivePageContext = shouldAttachActivePageContext(text) || activePageFollowup
    const tabId = activeId
    const content = activeTab && attachActivePageContext
      ? `[Active page: ${activeTab.title || ''} — ${activeTab.url}]\n\n${text}`
      : text
    const history: ChatMessage[] = [...prior, { role: 'user', content }]

    const requestId = newRequestId()
    const assistantMessageId = newMessageId()
    activeReq.current = requestId
    activeAssistantMessageId.current = assistantMessageId
    tts.stop() // silence any audio from the previous reply before this one starts
    setStreaming(true)
    setMessages((m) => [...m, userMsg, { id: assistantMessageId, role: 'assistant', text: '' }])
    // Sending a new message is an unambiguous "I want to see the reply" signal.
    // Re-enable follow mode regardless of where the user had scrolled before.
    autoScroll.scrollToBottom()
    if (restoredRef.current) {
      void persistConversation(buildConversation(convId, nextMessages), false).catch((err) => {
        console.warn('[chat] pre-send conversation save failed:', (err as Error)?.message ?? err)
      })
    }
    if (activeReq.current !== requestId) return
    window.gladdis.chat.send({
      requestId,
      assistantMessageId,
      modelId,
      messages: history,
      mode: 'agent',
      tabId,
      conversationId: convId,
      contextHints: { activePageFollowup },
      agent: selectedAgent ?? undefined
    })
  }

  const onInterject = ({ text, mode }: ComposerSubmit & { mode: ComposerInterjectionMode }) => {
    const requestId = activeReq.current
    if (!requestId) return
    const clean = text.trim()
    if (!clean) return

    window.gladdis.chat.interject({
      requestId,
      text: clean,
      pause: mode === 'pause',
      autoResume: mode === 'pause'
    })
    setMessages((m) => {
      const userMsg: Message = { id: newMessageId(), role: 'user', text: clean }
      const assistantId = activeAssistantMessageId.current
      const assistantIndex = assistantId
        ? m.findIndex((message) => message.role === 'assistant' && message.id === assistantId)
        : -1
      if (assistantIndex === -1) return [...m, userMsg]
      return [...m.slice(0, assistantIndex), userMsg, ...m.slice(assistantIndex)]
    })
    autoScroll.scrollToBottom()
  }

  const stop = () => {
    if (activeReq.current) {
      window.gladdis.chat.abort(activeReq.current)
      activeReq.current = null
      activeAssistantMessageId.current = null
      tts.stop()
      setStreaming(false)
      setPaused(false)
    }
  }

  /**
   * Hold the in-flight agent loop at the next iteration boundary. The
   * model stream currently being consumed finishes normally; the loop then
   * blocks before the next iteration. Tracks the paused flag locally so the
   * composer can flip the button without waiting for an echo from main.
   */
  const pause = () => {
    if (!activeReq.current || paused) return
    window.gladdis.chat.pause(activeReq.current)
    setPaused(true)
  }

  const resume = () => {
    if (!activeReq.current || !paused) return
    window.gladdis.chat.resume(activeReq.current)
    setPaused(false)
  }

  const activeModel = models.find((m) => m.id === modelId) ?? MODELS.find((m) => m.id === modelId) ?? null
  const pauseSupported = activeModel?.provider !== 'codex' && activeModel?.provider !== 'claudecode'

  const newChat = () => {
    if (activeReq.current) {
      window.gladdis.chat.abort(activeReq.current)
      activeReq.current = null
      activeAssistantMessageId.current = null
    }
    tts.stop()
    void flushPersist()
    setStreaming(false)
    setPaused(false)
    setMessages([])
    continuesFromId.current = null
    convCreatedAt.current = Date.now()
    setConvId(newConversationId())
    lastSavedSignatureRef.current = null
    setHistoryRev((r) => r + 1)
  }

  const loadConversation = async (id: string) => {
    if (id === convId) {
      setShowSettings(false)
      return
    }
    if (activeReq.current) {
      window.gladdis.chat.abort(activeReq.current)
      activeReq.current = null
      activeAssistantMessageId.current = null
    }
    tts.stop()
    void flushPersist()
    setStreaming(false)
    setPaused(false)
    const conv = await window.gladdis.chats.get(id)
    if (conv) {
      setConvId(conv.id)
      convCreatedAt.current = conv.createdAt
      continuesFromId.current = conv.continuesFromId ?? null
      lastSavedSignatureRef.current = conversationSignature(
        conv.id,
        conv.createdAt,
        conv.messages as Message[],
        conv.continuesFromId ?? null
      )
      setMessages(conv.messages as Message[])
      requestAnimationFrame(() => autoScroll.scrollToBottom())
    }
    setShowSettings(false)
  }

  const continueFromConversation = async (id: string) => {
    if (activeReq.current) {
      window.gladdis.chat.abort(activeReq.current)
      activeReq.current = null
      activeAssistantMessageId.current = null
    }
    tts.stop()
    void flushPersist()
    setStreaming(false)
    setPaused(false)
    setMessages([])
    continuesFromId.current = id
    convCreatedAt.current = Date.now()
    setConvId(newConversationId())
    lastSavedSignatureRef.current = null
    setHistoryRev((r) => r + 1)
    setShowSettings(false)
  }

  // Zoom scales the conversation typography only. The composer is application
  // chrome, not content: its height, font sizes, and hint typography are held
  // constant so the input box looks identical on both panels regardless of
  // either panel's chat zoom.
  const chatStyle = {
    '--chat-zoom': zoom,
    '--chat-message-size': px(15 * zoom),
    '--chat-md-h1-size': px(20 * zoom),
    '--chat-md-h2-size': px(17 * zoom),
    '--chat-md-h3-size': px(15.5 * zoom),
    '--chat-code-size': px(13 * zoom),
    '--chat-pre-code-size': px(12 * zoom),
    '--chat-small-size': px(11.5 * zoom),
    '--chat-tiny-size': px(10 * zoom),
    '--chat-message-gap': px(Math.min(20, Math.max(10, 14 * zoom))),
    '--chat-pad-y': px(Math.min(22, Math.max(12, 16 * zoom))),
    '--chat-pad-x': px(Math.min(20, Math.max(12, 16 * zoom)))
  } as CSSProperties

  const turnControls = (
    <TurnControls
      modelId={modelId}
      models={models}
      onModelChange={persistModel}
      agentId={agentId}
      agents={agents}
      onAgentChange={persistAgent}
      onCreateAgent={onCreateAgent}
      onEditAgent={onEditAgent}
      onDeleteAgent={deleteAgent}
      keyStatus={keyStatus}
      codexStatus={codexStatus}
      claudeCodeStatus={claudeCodeStatus}
      workspace={workspace}
      onPickWorkspace={pickWorkspace}
    />
  )
  const footerActions = (
    <ChatSettingsButton
      panelLabel={panelId === 'left' ? 'Left' : 'Right'}
      open={showSettings}
      onOpen={() => {
        setSettingsTab('history')
        setShowSettings(true)
      }}
    />
  )
  const footerTokens = <TokenCounter records={auditRecords} conversationId={convId} />

  return (
    <>
      <div className="chat" style={chatStyle}>
        <div className="chat-messages" ref={scrollRef}>
          <ChatMessageList messages={messages} streaming={streaming} />
        </div>

        {!autoScroll.isAtBottom && messages.length > 0 && (
          <button
            type="button"
            className="chat-jump-bottom"
            aria-label="Jump to latest message"
            title="Jump to latest"
            onClick={() => autoScroll.scrollToBottom('smooth')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 6.5 8 10.5 12 6.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}

        <Composer
          activeId={activeId}
          busy={streaming}
          onSubmit={onSubmit}
          onInterject={onInterject}
          onStop={stop}
          onPause={pauseSupported ? pause : undefined}
          onResume={pauseSupported ? resume : undefined}
          paused={paused}
          audioOn={audioOn}
          onToggleAudio={toggleAudio}
          voice={voice}
          onVoiceChange={persistVoice}
          speed={speed}
          onSpeedChange={persistSpeed}
          turnControls={turnControls}
          onNewChat={newChat}
          newDisabled={messages.length === 0 && !streaming}
        />

        {showSettings && (
          <ChatSettingsModal
            auditRecords={auditRecords}
            codexStatus={codexStatus}
            claudeCodeStatus={claudeCodeStatus}
            currentId={convId}
            initialTab={settingsTab}
            keyStatus={keyStatus}
            panel={panelId}
            refreshKey={historyRev}
            onClose={() => setShowSettings(false)}
            onKeysSaved={setKeyStatus}
            onPickHistory={loadConversation}
            onContinueHistory={continueFromConversation}
          />
        )}
      </div>
      {footerSlot && createPortal(footerActions, footerSlot)}
      {footerTokenSlot && createPortal(footerTokens, footerTokenSlot)}
    </>
  )
}
