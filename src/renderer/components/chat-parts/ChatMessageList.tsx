import { ChatMessageBody } from '../ChatMessageBody'
import { CopyButton } from '../CopyButton'
import type { Message } from '../chatTypes'

/**
 * Renders the assistant/user transcript stack inside the chat panel. The
 * "copy reply" button only appears once the streaming assistant message has
 * settled — showing it on a half-streamed bubble would copy a truncated
 * reply.
 */
export function ChatMessageList({
  messages,
  streaming
}: {
  messages: Message[]
  streaming: boolean
}) {
  if (messages.length === 0) {
    return (
      <div className="chat-empty">
        Ask anything.
        <br />
        The browser on the right is fully owned via CDP.
      </div>
    )
  }
  return (
    <>
      {messages.map((m, i) =>
        m.role === 'assistant' ? (
          <div key={i} className="chat-msg assistant">
            <ChatMessageBody message={m} />
            {m.text && !(streaming && i === messages.length - 1) && <CopyButton text={m.text} />}
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
      )}
    </>
  )
}
