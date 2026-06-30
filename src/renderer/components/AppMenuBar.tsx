import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAppMenuGroups,
  formatMenuAccelerator,
  type AppMenuPlatform,
  type AppMenuEntry,
  type MenuAction
} from '../../../shared/appMenu'

interface Props {
  hasWorkspace: boolean
}

function entryDisabled(entry: AppMenuEntry, hasWorkspace: boolean): boolean {
  if (entry.type === 'separator') return false
  if (!entry.requiresWorkspace) return false
  return !hasWorkspace
}

async function runMenuAction(action: MenuAction): Promise<void> {
  switch (action.kind) {
    case 'role':
      window.gladdis.menu.invokeRole(action.role)
      return
    case 'app':
      window.gladdis.app.dispatch(action.command)
      return
    case 'new-folder':
      await window.gladdis.workspace.promptNewFolder()
      return
    case 'open-folder':
      await window.gladdis.workspace.pickFolder()
      return
    case 'toggle-fullscreen':
      window.gladdis.win.toggleMaximize()
      return
  }
}

function MenuRows({
  platform,
  items,
  hasWorkspace,
  onActivate,
  activeSubmenu,
  onHoverSubmenu
}: {
  platform: AppMenuPlatform
  items: AppMenuEntry[]
  hasWorkspace: boolean
  onActivate: () => void
  activeSubmenu: string | null
  onHoverSubmenu: (key: string | null) => void
}) {
  return (
    <>
      {items.map((entry, index) => {
        if (entry.type === 'separator') {
          return <div key={`sep-${index}`} className="app-menu-separator" role="separator" />
        }

        const disabled = entryDisabled(entry, hasWorkspace)

        if (entry.type === 'submenu') {
          const key = `${entry.label}-${index}`
          const subOpen = activeSubmenu === key
          return (
            <div
              key={key}
              className={`app-menu-sub-wrap ${disabled ? 'disabled' : ''} ${subOpen ? 'active' : ''}`}
              onMouseEnter={() => !disabled && onHoverSubmenu(key)}
            >
              <button
                type="button"
                role="menuitem"
                className="app-menu-row app-menu-row-submenu"
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={subOpen}
              >
                <span className="app-menu-label">{entry.label}</span>
                <span className="app-menu-chevron" aria-hidden>
                  ›
                </span>
              </button>
              {subOpen && (
                <div className="app-menu-submenu" role="menu">
                  <MenuRows
                    platform={platform}
                    items={entry.items}
                    hasWorkspace={hasWorkspace}
                    onActivate={onActivate}
                    activeSubmenu={null}
                    onHoverSubmenu={() => {}}
                  />
                </div>
              )}
            </div>
          )
        }

        const accel = formatMenuAccelerator(platform, entry.accelerator)
        return (
          <button
            key={`${entry.label}-${index}`}
            type="button"
            role="menuitem"
            className="app-menu-row"
            disabled={disabled}
            onClick={() => {
              if (disabled) return
              void runMenuAction(entry.action)
              onActivate()
            }}
          >
            <span className="app-menu-label">{entry.label}</span>
            {accel && <span className="app-menu-accel">{accel}</span>}
          </button>
        )
      })}
    </>
  )
}

/** Anchored titlebar menus — dropdown panels sit flush under their tab trigger. */
export function AppMenuBar({ hasWorkspace }: Props) {
  const [platform, setPlatform] = useState<AppMenuPlatform>('linux')
  const [openLabel, setOpenLabel] = useState<string | null>(null)
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const groups = getAppMenuGroups(platform)

  const closeMenus = useCallback(() => {
    setOpenLabel(null)
    setActiveSubmenu(null)
  }, [])

  useEffect(() => {
    void window.gladdis.shell.platform().then(setPlatform).catch(() => {})
  }, [])

  useEffect(() => {
    if (!openLabel) return
    const onDocMouseDown = (event: MouseEvent) => {
      if (barRef.current?.contains(event.target as Node)) return
      closeMenus()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenus()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openLabel, closeMenus])

  return (
    <div className="titlebar-menus app-menu-bar" ref={barRef}>
      {groups.map((group) => {
        const isOpen = openLabel === group.label
        return (
          <div
            key={group.label}
            className={`app-menu-anchor ${isOpen ? 'open' : ''}`}
            onMouseLeave={() => setActiveSubmenu(null)}
          >
            <button
              type="button"
              className={`titlebar-menu-btn ${isOpen ? 'open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => {
                setActiveSubmenu(null)
                setOpenLabel((current) => (current === group.label ? null : group.label))
              }}
            >
              {group.label}
            </button>
            {isOpen && (
              <div className="app-menu-dropdown" role="menu">
                <MenuRows
                  platform={platform}
                  items={group.items}
                  hasWorkspace={hasWorkspace}
                  onActivate={closeMenus}
                  activeSubmenu={activeSubmenu}
                  onHoverSubmenu={setActiveSubmenu}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
