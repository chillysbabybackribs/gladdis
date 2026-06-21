import { useState } from 'react'

/** Icon-only copy control shown under an assistant reply. No wrapper. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <button
      className="copy-btn"
      onClick={copy}
      title={copied ? 'Copied' : 'Copy'}
      aria-label="Copy response"
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M3.5 8.5l3 3 6-7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <rect
            x="5.5"
            y="5.5"
            width="8"
            height="8"
            rx="1.8"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
}
