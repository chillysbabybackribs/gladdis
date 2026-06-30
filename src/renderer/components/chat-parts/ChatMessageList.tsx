import { memo } from 'react'
import { ChatMessageBody } from '../ChatMessageBody'
import { CopyButton } from '../CopyButton'
import type { Message } from '../chatTypes'
import { openImageInTab } from '../../lib/openImageInTab'

function UserMessageRow({ message }: { message: Message }) {
  return (
    <div className="chat-msg user">
      {message.text}
      {message.images && message.images.length > 0 && (
        <div className="chat-msg-images">
          {message.images.map((img, idx) => (
            <img
              key={idx}
              src={img}
              alt="attachment"
              className="chat-msg-thumb"
              onClick={() => void openImageInTab(img, 'Chat attachment')}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const MemoUserMessageRow = memo(
  UserMessageRow,
  (prev, next) => prev.message === next.message
)

function AssistantMessageRow({
  message,
  isStreaming
}: {
  message: Message
  isStreaming: boolean
}) {
  return (
    <div className="chat-msg assistant">
      <ChatMessageBody message={message} />
      {message.text && !isStreaming && <CopyButton text={message.text} />}
    </div>
  )
}

const MemoAssistantMessageRow = memo(
  AssistantMessageRow,
  (prev, next) => prev.message === next.message && prev.isStreaming === next.isStreaming
)

/**
 * Renders the assistant/user transcript stack inside the chat panel. The
 * "copy reply" button only appears once the streaming assistant message has
 * settled — showing it on a half-streamed bubble would copy a truncated
 * reply.
 */
export function ChatMessageList({
  messages,
  streaming,
  streamingAssistantMessageId
}: {
  messages: Message[]
  streaming: boolean
  streamingAssistantMessageId?: string | null
}) {
  if (messages.length === 0) {
    return (
      <div className="chat-empty">
        Ask anything.
        <br />
        The browser on the left is fully owned via CDP.
      </div>
    )
  }

  return (
    <>
      {messages.map((m, i) => {
        const itemKey = m.id ?? `${m.role}-${i}`
        const isStreamingAssistant =
          streaming &&
          m.role === 'assistant' &&
          (streamingAssistantMessageId ? m.id === streamingAssistantMessageId : i === messages.length - 1)
        return m.role === 'assistant' ? (
          <MemoAssistantMessageRow key={itemKey} message={m} isStreaming={isStreamingAssistant} />
        ) : (
          <MemoUserMessageRow key={itemKey} message={m} />
        )
      })}
    </>
  )
}
