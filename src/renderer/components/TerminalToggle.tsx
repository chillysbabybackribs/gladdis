interface Props {
  open: boolean
  onClick: () => void
}

/**
 * Center-pinned terminal toggle that lives in the existing .workspace-footer
 * rail. Same Cursor-dark styling as the chat-zoom controls; positions itself
 * via absolute centering (the rail's flex spacer can't always center it when
 * the side-chat groups are different widths).
 */
export function TerminalToggle({ open, onClick }: Props) {
  return (
    <button
      type="button"
      className={`footer-terminal-toggle ${open ? 'is-open' : ''}`}
      title={open ? 'Close terminal' : 'Open terminal'}
      aria-label={open ? 'Close terminal' : 'Open terminal'}
      aria-pressed={open}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path
          d="M3.5 6.5l2 1.7-2 1.7M7.5 10.2h5"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="footer-terminal-label">Terminal</span>
    </button>
  )
}
