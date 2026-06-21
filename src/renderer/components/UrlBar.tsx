import { useEffect, useState } from 'react'
import type { TabInfo } from '../../../shared/types'

interface Props {
  tab: TabInfo | null
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

export function UrlBar({ tab, onNavigate, onBack, onForward, onReload }: Props) {
  const [value, setValue] = useState('')

  // Reflect the active tab's URL unless the user is mid-edit.
  useEffect(() => {
    setValue(tab?.url ?? '')
  }, [tab?.url, tab?.id])

  const submit = () => {
    if (!tab) return
    onNavigate(value.trim())
  }

  return (
    <div className="urlbar">
      <button className="nav" onClick={onBack} disabled={!tab?.canGoBack} title="Back">
        ‹
      </button>
      <button className="nav" onClick={onForward} disabled={!tab?.canGoForward} title="Forward">
        ›
      </button>
      <button className="nav" onClick={onReload} disabled={!tab} title="Reload">
        ⟳
      </button>
      <input
        value={value}
        disabled={!tab}
        placeholder="Search or enter address"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          submit()
        }}
      />
    </div>
  )
}
