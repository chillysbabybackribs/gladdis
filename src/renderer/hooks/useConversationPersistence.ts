import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import type { ChatPanelSide, Conversation } from '../../../shared/types'
import type { Message } from '../components/chatTypes'

const SAVE_DEBOUNCE_MS = 400

export interface ConversationPersistenceArgs {
  /** Which side owns this chat. Stamped on every save so the conv is sticky to this panel. */
  panel: ChatPanelSide
  /** Live conversation id ref — must always reflect the current chat. */
  convIdRef: MutableRefObject<string>
  /** Live messages ref — used by the debounced save to read latest state without re-binding. */
  messagesRef: MutableRefObject<Message[]>
  /** Active model id — debounced save needs the latest value to attach for autotitling. */
  modelIdRef: MutableRefObject<string>
  /** Conversation creation time for the active chat. */
  createdAtRef: MutableRefObject<number>
  /** Optional parent-conversation id when the user "continues" from history. */
  continuesFromIdRef: MutableRefObject<string | null>
  /** Latest streaming flag — debounced save no-ops while a stream is mid-flight. */
  streaming: boolean
  /** Latest message tuple to react to — wired from setMessages so persistence reflects edits. */
  messages: Message[]
  /** Live convId state value (for effect dependency tracking). */
  convId: string
  /** Triggers the History modal refresh after a successful save. */
  bumpHistoryRev: () => void
}

export interface ConversationPersistence {
  /** True once the panel has restored its last-active conversation. */
  restoredRef: MutableRefObject<boolean>
  /** Stable per-conversation signature — used to avoid no-op saves. */
  conversationSignature: (
    conversationId: string,
    createdAt: number,
    nextMessages: Message[],
    parentId?: string | null
  ) => string
  /** Last signature successfully written, so we can short-circuit. */
  lastSavedSignatureRef: MutableRefObject<string | null>
  /** Build the canonical Conversation payload from the live refs. */
  buildConversation: (
    conversationId?: string,
    nextMessages?: Message[],
    createdAt?: number,
    parentId?: string | null
  ) => Conversation
  /** Best-effort persist; respects the lastSavedSignature short-circuit. */
  persistConversation: (conversation: Conversation, postSave?: boolean) => Promise<Conversation>
  /** Async flush; cancels any pending debounce and writes immediately. */
  flushPersist: (postSave?: boolean) => Promise<Conversation | null>
  /** Synchronous flush (used in `beforeunload`) — never returns a promise. */
  flushPersistSync: (postSave?: boolean) => void
  /** Conversations that have already been auto-titled (stable across renders). */
  titledIdsRef: MutableRefObject<Set<string>>
}

/**
 * Encapsulates the chat panel's conversation persistence: signatures,
 * debounced + immediate saves, beforeunload sync flush, and post-save
 * auto-title scheduling. The hook intentionally takes refs for the values
 * the debounced + sync paths need to read at flush-time, so callers can keep
 * a single source of truth in the parent component.
 */
export function useConversationPersistence(
  args: ConversationPersistenceArgs
): ConversationPersistence {
  const {
    panel,
    convIdRef,
    messagesRef,
    modelIdRef,
    createdAtRef,
    continuesFromIdRef,
    streaming,
    messages,
    convId,
    bumpHistoryRev
  } = args

  const restoredRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedSignatureRef = useRef<string | null>(null)
  const titledIdsRef = useRef<Set<string>>(new Set())

  const conversationSignature = (
    conversationId: string,
    createdAt: number,
    nextMessages: Message[],
    parentId: string | null = continuesFromIdRef.current
  ) => JSON.stringify({
    id: conversationId,
    createdAt,
    continuesFromId: parentId,
    panel,
    messages: nextMessages
  })

  const buildConversation = (
    conversationId = convIdRef.current,
    nextMessages = messagesRef.current,
    createdAt = createdAtRef.current,
    parentId: string | null = continuesFromIdRef.current
  ): Conversation => ({
    id: conversationId,
    title: '', // derived in the main process from the first user message
    continuesFromId: parentId,
    panel,
    createdAt,
    updatedAt: Date.now(),
    messages: nextMessages
  })

  const postPersist = (conversationId: string, nextMessages: Message[]) => {
    const firstUser = nextMessages.find((m) => m.role === 'user' && m.text.trim())
    const firstReply = nextMessages.find((m) => m.role === 'assistant' && m.text.trim())
    if (firstUser && firstReply && !titledIdsRef.current.has(conversationId)) {
      titledIdsRef.current.add(conversationId)
      void window.gladdis.chats.autoTitle(conversationId, modelIdRef.current).then((title) => {
        if (title) bumpHistoryRev()
      })
    }
  }

  const persistConversation = async (conversation: Conversation, postSave = true) => {
    if (conversation.messages.length === 0) return conversation
    const signature = conversationSignature(
      conversation.id,
      conversation.createdAt,
      conversation.messages as Message[]
    )
    if (lastSavedSignatureRef.current === signature) return conversation
    const saved = await window.gladdis.chats.save(conversation)
    lastSavedSignatureRef.current = signature
    if (postSave) postPersist(saved.id, saved.messages as Message[])
    return saved
  }

  const flushPersist = async (postSave = true): Promise<Conversation | null> => {
    if (!restoredRef.current) return null
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const conv = buildConversation()
    if (conv.messages.length === 0) return null
    return persistConversation(conv, postSave)
  }

  const flushPersistSync = (postSave = true): void => {
    if (!restoredRef.current) return
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
    if (lastSavedSignatureRef.current === signature) return
    const saved = window.gladdis.chats.saveSync(conv)
    lastSavedSignatureRef.current = signature
    if (postSave) postPersist(saved.id, saved.messages as Message[])
  }

  const debouncedSave = useMemo(() => {
    return () => {
      if (!restoredRef.current) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        const conv = buildConversation(convIdRef.current, messagesRef.current, createdAtRef.current)
        void persistConversation(conv)
      }, SAVE_DEBOUNCE_MS)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist on every meaningful change, but never while a stream is mid-flight —
  // the partial assistant message would clobber the eventual final text.
  useEffect(() => {
    if (streaming) return
    debouncedSave()
  }, [messages, convId, debouncedSave, streaming])

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
    }
  }, [])

  useEffect(() => {
    const onBeforeUnload = () => flushPersistSync(false)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    restoredRef,
    conversationSignature,
    lastSavedSignatureRef,
    buildConversation,
    persistConversation,
    flushPersist,
    flushPersistSync,
    titledIdsRef
  }
}
