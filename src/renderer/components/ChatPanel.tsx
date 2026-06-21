import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type {
  ChatMessage,
  Conversation,
  KeyStatus,
  CodexStatus,
  ModelCallRecord,
  ModelOption,
  TabInfo,
  Workspace
} from '../../../shared/types'
import {
  MODELS,
  shouldAttachActivePageContext,
  shouldContinueActivePageContext
} from '../../../shared/types'
import { Composer, type ComposerSubmit } from './Composer'
import { ModelPicker } from './ModelPicker'
import { CopyButton } from './CopyButton'
import { ChatSettingsModal } from './ChatSettingsModal'
import { useTts, useTtsSettings } from '../hooks/useTts'
import { ChatMessageBody } from './ChatMessageBody'
import { useStreamConsumer } from '../hooks/useStreamConsumer'
import { previousTurnAttachedActivePage } from '../lib/chatTurnContext'
import type { Message } from './chatTypes'
import { appendText } from './chatTypes'

let reqCounter = 0
const newRequestId = () => `req-${Date.now()}-${reqCounter++}`

let msgCounter = 0
const newMessageId = () => `msg-${Date.now()}-${msgCounter++}`

let convCounter = 0
const newConversationId = () => `conv-${Date.now()}-${convCounter++}`

export type PanelId = 'left' | 'right'

const modelKey = (panelId: PanelId) => `gladdis:model:${panelId}`
const audioKey = (panelId: PanelId) => `gladdis:audio:${panelId}`

const RECENT_TURNS = 8

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`
}

export function ChatPanel({
  panelId = 'left',
  zoom = 1,
  footerSlot = null
}: {
  panelId?: PanelId
  zoom?: number
  footerSlot?: HTMLElement | null
} = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [convId, setConvId] = useState<string>(() => newConversationId())
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'history' | 'keys' | 'calls'>('history')
  const [auditRecords, setAuditRecords] = useState<ModelCallRecord[]>([])
  const [historyRev, setHistoryRev] = useState(0)
  const convCreatedAt = useRef<number>(Date.now())
  const continuesFromId = useRef<string | null>(null)
  const restored = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedSignature = useRef<string | null>(null)
  const titledIds = useRef<Set<string>>(new Set())
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string>(() => {
    const saved = localStorage.getItem(modelKey(panelId))
    return saved && MODELS.some((m) => m.id === saved) ? saved : MODELS[0].id
  })
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({
    anthropic: false,
    google: false,
    codex: false,
    openai: false,
    grok: false
  })
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [models, setModels] = useState<ModelOption[]>(MODELS)
  const [workspace, setWorkspace] = useState<Workspace>({ folder: null })
  const [streaming, setStreaming] = useState(false)
  const [audioOn, setAudioOn] = useState(
    () => localStorage.getItem(audioKey(panelId)) === '1'
  )
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
  const convIdRef = useRef(convId)
  const messagesRef = useRef(messages)
  const modelIdRef = useRef(modelId)

  convIdRef.current = convId
  messagesRef.current = messages
  modelIdRef.current = modelId

  const postPersist = (conversationId: string, nextMessages: Message[]) => {
    const firstUser = nextMessages.find((m) => m.role === 'user' && m.text.trim())
    const firstReply = nextMessages.find((m) => m.role === 'assistant' && m.text.trim())
    if (firstUser && firstReply && !titledIds.current.has(conversationId)) {
      titledIds.current.add(conversationId)
      void window.gladdis.chats.autoTitle(conversationId, modelIdRef.current).then((title) => {
        if (title) setHistoryRev((r) => r + 1)
      })
    }
  }

  const conversationSignature = (
    conversationId: string,
    createdAt: number,
    nextMessages: Message[],
    parentId = continuesFromId.current
  ) => JSON.stringify({ id: conversationId, createdAt, continuesFromId: parentId, messages: nextMessages })

  const buildConversation = (
    conversationId = convIdRef.current,
    nextMessages = messagesRef.current,
    createdAt = convCreatedAt.current,
    parentId = continuesFromId.current
  ): Conversation => ({
    id: conversationId,
    title: '', // derived in the main process from the first user message
    continuesFromId: parentId,
    createdAt,
    updatedAt: Date.now(),
    messages: nextMessages
  })

  const persistConversation = async (conversation: Conversation, postSave = true) => {
    if (conversation.messages.length === 0) return conversation
    const signature = conversationSignature(
      conversation.id,
      conversation.createdAt,
      conversation.messages as Message[]
    )
    if (lastSavedSignature.current === signature) return conversation
    const saved = await window.gladdis.chats.save(conversation)
    lastSavedSignature.current = signature
    if (postSave) postPersist(saved.id, saved.messages as Message[])
    return saved
  }

  const flushPersist = async (postSave = true): Promise<Conversation | null> => {
    if (!restored.current) return null
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const conv = buildConversation()
    if (conv.messages.length === 0) return null
    return persistConversation(conv, postSave)
  }

  const flushPersistSync = (postSave = true): void => {
    if (!restored.current) return
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const conv = buildConversation()
    if (conv.messages.length === 0) return
    const signature = conversationSignature(
      conv.id,
      conv.createdAt,
      conv.messages as Message[]
    )
    if (lastSavedSignature.current === signature) return
    const saved = window.gladdis.chats.saveSync(conv)
    lastSavedSignature.current = signature
    if (postSave) postPersist(saved.id, saved.messages as Message[])
  }

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
    void window.gladdis.keys.status().then(setKeyStatus)
    void window.gladdis.workspace.get().then(setWorkspace)
    void window.gladdis.codex.status().then(setCodexStatus).catch(() => setCodexStatus(null))
    void window.gladdis.codex
      .models()
      .then((codexModels) => {
        if (!codexModels.length) return
        const nonCodex = MODELS.filter((m) => m.provider !== 'codex')
        setModels([...nonCodex, ...codexModels])
      })
      .catch(() => {
        /* keep static fallback */
      })
  }, [])

  useEffect(() => {
    void window.gladdis.audit.list().then(setAuditRecords)
    const off = window.gladdis.audit.onEvent((event) => {
      setAuditRecords((records) => {
        const byId = new Map(records.map((r) => [r.id, r]))
        byId.set(event.record.id, event.record)
        return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
      })
    })
    return off
  }, [])

  useEffect(() => {
    if (panelId !== 'left') {
      restored.current = true
      return
    }
    void (async () => {
      try {
        const id = await window.gladdis.chats.lastActive()
        const conv = id ? await window.gladdis.chats.get(id) : null
      if (conv && conv.messages.length) {
        setConvId(conv.id)
        convCreatedAt.current = conv.createdAt
        continuesFromId.current = conv.continuesFromId ?? null
        lastSavedSignature.current = conversationSignature(
          conv.id,
          conv.createdAt,
          conv.messages as Message[],
          conv.continuesFromId ?? null
        )
        setMessages(conv.messages as Message[])
      }
      } finally {
        restored.current = true
      }
    })()
  }, [])

  useEffect(() => {
    if (!restored.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      const conv = buildConversation(convId, messages, convCreatedAt.current)
      void persistConversation(conv)
    }, 400)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [messages, convId])

  useEffect(() => {
    const onBeforeUnload = () => {
      flushPersistSync(false)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useStreamConsumer({
    activeReq,
    activeAssistantMessageId,
    ttsRef,
    scrollRef,
    setMessages,
    setStreaming
  })

  const persistModel = (id: string) => {
    setModelId(id)
    localStorage.setItem(modelKey(panelId), id)
  }

  const toggleAudio = () => {
    setAudioOn((on) => {
      const next = !on
      localStorage.setItem(audioKey(panelId), next ? '1' : '0')
      // Turning on without a key is a no-op that silently fails; nudge the user
      // to set the OpenAI key so they know why nothing is spoken.
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
        : model.provider === 'anthropic'
          ? keyStatus.anthropic
          : model.provider === 'grok'
            ? keyStatus.grok
            : keyStatus.google
    if (!usable) {
      setSettingsTab('keys')
      setShowSettings(true)
      return
    }

    const activeTab = tabs.find((t) => t.id === activeId) ?? null
    const userMsg: Message = {
      role: 'user',
      text
    }
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
    if (restored.current) {
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
      contextHints: { activePageFollowup }
    })
  }

  const stop = () => {
    if (activeReq.current) {
      window.gladdis.chat.abort(activeReq.current)
      activeReq.current = null
      activeAssistantMessageId.current = null
      tts.stop()
      setStreaming(false)
    }
  }

  const newChat = () => {
    if (activeReq.current) {
      window.gladdis.chat.abort(activeReq.current)
      activeReq.current = null
      activeAssistantMessageId.current = null
    }
    tts.stop()
    void flushPersist()
    setStreaming(false)
    setMessages([])
    continuesFromId.current = null
    convCreatedAt.current = Date.now()
    setConvId(newConversationId())
    lastSavedSignature.current = null
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
    const conv = await window.gladdis.chats.get(id)
    if (conv) {
      setConvId(conv.id)
      convCreatedAt.current = conv.createdAt
      continuesFromId.current = conv.continuesFromId ?? null
      lastSavedSignature.current = conversationSignature(
        conv.id,
        conv.createdAt,
        conv.messages as Message[],
        conv.continuesFromId ?? null
      )
      setMessages(conv.messages as Message[])
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
    setMessages([])
    continuesFromId.current = id
    convCreatedAt.current = Date.now()
    setConvId(newConversationId())
    lastSavedSignature.current = null
    setHistoryRev((r) => r + 1)
    setShowSettings(false)
  }

  const pickWorkspace = async () => {
    const ws = await window.gladdis.workspace.pickFolder()
    setWorkspace(ws)
  }

  // Short, tail-end label for the chosen folder (e.g. ".../Desktop/gladdis").
  const folderLabel = workspace.folder
    ? workspace.folder.split('/').filter(Boolean).slice(-2).join('/')
    : null
  const turnControls = (
    <div className="composer-turn-controls">
      <ModelPicker
        value={modelId}
        onChange={persistModel}
        models={models}
        keyStatus={keyStatus}
        codexStatus={codexStatus}
      />
      <button
        className={`workspace-btn ${workspace.folder ? 'set' : ''}`}
        title={
          workspace.folder
            ? `Working folder: ${workspace.folder}\nClick to change`
            : 'Choose a folder to work from'
        }
        aria-label="Choose working folder"
        onClick={pickWorkspace}
      >
        <svg width="15" height="15" viewBox="0 0 18 18" fill="none">
          <path
            d="M2.25 5.25A1.5 1.5 0 0 1 3.75 3.75h3l1.5 1.5h6a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V5.25Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        {folderLabel && <span className="workspace-label">{folderLabel}</span>}
      </button>
    </div>
  )
  const footerActions = (
    <button
      className={`footer-action ${showSettings ? 'is-open' : ''}`}
      title={`${panelId === 'left' ? 'Left' : 'Right'} chat settings`}
      aria-label={`${panelId === 'left' ? 'Left' : 'Right'} chat settings`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        setSettingsTab('history')
        setShowSettings(true)
      }}
    >
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M9 6.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <path
          d="M9 2.8v1.55M9 13.65v1.55M3.62 5.9l1.35.78M13.03 11.32l1.35.78M3.62 12.1l1.35-.78M13.03 6.68l1.35-.78"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
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
    '--chat-message-gap': px(Math.min(26, Math.max(14, 18 * zoom))),
    '--chat-pad-y': px(Math.min(28, Math.max(16, 20 * zoom))),
    '--chat-pad-x': px(Math.min(24, Math.max(14, 18 * zoom))),
    '--chat-composer-h': px(Math.min(178, Math.max(158, 132 * zoom)))
  } as CSSProperties

  return (
    <>
    <div className="chat" style={chatStyle}>
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            Ask anything.
            <br />
            The browser on the right is fully owned via CDP.
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === 'assistant' ? (
              <div key={i} className="chat-msg assistant">
                <ChatMessageBody message={m} />
                {/* Show copy once the stream for this turn has finished. */}
                {m.text && !(streaming && i === messages.length - 1) && (
                  <CopyButton text={m.text} />
                )}
              </div>
            ) : (
              <div key={i} className="chat-msg user">
                {m.text}
                {m.images && m.images.length > 0 && (
                  <div className="chat-msg-images">
                    {m.images.map((img, idx) => (
                      <img
                        key={idx}
                        src={img}
                        alt="attachment"
                        className="chat-msg-thumb"
                        onClick={() => window.open(img, '_blank')}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          )
        )}
      </div>

      <Composer
        activeId={activeId}
        busy={streaming}
        onSubmit={onSubmit}
        onStop={stop}
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
          currentId={convId}
          initialTab={settingsTab}
          keyStatus={keyStatus}
          refreshKey={historyRev}
          onClose={() => setShowSettings(false)}
          onKeysSaved={setKeyStatus}
          onPickHistory={loadConversation}
          onContinueHistory={continueFromConversation}
        />
      )}
    </div>
    {footerSlot && createPortal(footerActions, footerSlot)}
    </>
  )
}
