interface Props {
  open: boolean
  onClick: () => void
}

/**
 * Footer-rail notepad toggle. Sits beside the terminal control in the
 * center of `.workspace-footer`.
 */
export function NotepadToggle({ open, onClick }: Props) {
  return (
    <button
      type="button"
      className={`footer-notepad-toggle ${open ? 'is-open' : ''}`}
      title={open ? 'Close notepad' : 'Open notepad'}
      aria-label={open ? 'Close notepad' : 'Open notepad'}
      aria-pressed={open}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3.5 2.5h7.8c.6 0 1.1.5 1.1 1.1v8.8c0 .6-.5 1.1-1.1 1.1H3.5c-.6 0-1.1-.5-1.1-1.1V3.6c0-.6.5-1.1 1.1-1.1z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.15"
          strokeLinejoin="round"
        />
        <path
          d="M5.2 2.5V4.8c0 .4.3.7.7.7h3.4c.4 0 .7-.3.7-.7V2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.15"
          strokeLinejoin="round"
        />
        <path
          d="M5.4 8.2h5.2M5.4 10.4h3.6"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
      <span className="footer-notepad-label">Notepad</span>
    </button>
  )
}
