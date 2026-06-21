import { useEffect, useRef, useState } from 'react'
import type { TabInfo } from '../../../shared/types'
import { TabStrip } from './TabStrip'
import { UrlBar } from './UrlBar'
import { useSlotBounds } from '../hooks/useSlotBounds'

export function BrowserPanel() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const active = tabs.find((t) => t.id === activeId) ?? null

  // Keep tab state in sync with main.
  useEffect(() => {
    const off = window.gladdis.tabs.onUpdated((next) => {
      setTabs(next)
      setActiveId((cur) => {
        if (cur && next.some((t) => t.id === cur)) return cur
        return next.length ? next[next.length - 1].id : null
      })
    })
    void window.gladdis.tabs.list().then((t) => {
      setTabs(t)
      if (t.length) setActiveId(t[t.length - 1].id)
    })
    return off
  }, [])

  // Report the stage rect to main so the native view fills it exactly. The hook
  // rAF-coalesces and dedups reports and re-measures on transitionend, so the
  // native view stays glued to the hole as the side drawers animate open/closed.
  useSlotBounds(stageRef, [activeId])

  const onSwitch = (id: string) => {
    setActiveId(id)
    void window.gladdis.tabs.switch(id)
  }

  return (
    <div className="browser">
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onSwitch={onSwitch}
        onClose={(id) => void window.gladdis.tabs.close(id)}
        onNew={() => void window.gladdis.tabs.create()}
        onReorder={(id, toIndex) => void window.gladdis.tabs.reorder(id, toIndex)}
      />
      <UrlBar
        tab={active}
        onNavigate={(url) => active && void window.gladdis.tabs.navigate(active.id, url)}
        onBack={() => active && void window.gladdis.tabs.back(active.id)}
        onForward={() => active && void window.gladdis.tabs.forward(active.id)}
        onReload={() => active && void window.gladdis.tabs.reload(active.id)}
      />
      <div className="browser-stage" ref={stageRef}>
        {!active && (
          <div className="browser-stage-empty">No tab open — hit + to start browsing.</div>
        )}
      </div>
    </div>
  )
}
