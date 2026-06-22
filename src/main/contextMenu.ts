import { Menu, clipboard, type MenuItemConstructorOptions, type WebContents, type Event } from 'electron'

interface ContextMenuParams {
  editFlags?: {
    canUndo?: boolean
    canRedo?: boolean
    canCut?: boolean
    canCopy?: boolean
    canPaste?: boolean
    canSelectAll?: boolean
  }
  isEditable?: boolean
  selectionText?: string
  linkURL?: string
  x?: number
  y?: number
}

function hasText(value: string | undefined): value is string {
  return !!value && value.trim().length > 0
}

export function attachContextMenu(
  webContents: WebContents,
  opts: {
    openLinkInNewTab?: (url: string) => void
    inspectElement?: boolean
  } = {}
): void {
  webContents.on('context-menu', (event: Event, params: ContextMenuParams) => {
    const template: MenuItemConstructorOptions[] = []
    const selectionText = params.selectionText ?? ''
    const linkURL = params.linkURL ?? ''
    const flags = params.editFlags ?? {}
    const canCopySelection = hasText(selectionText) && flags.canCopy !== false

    if (params.isEditable) {
      template.push(
        { role: 'undo', enabled: !!flags.canUndo },
        { role: 'redo', enabled: !!flags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: !!flags.canCut },
        { role: 'copy', enabled: !!flags.canCopy },
        { role: 'paste', enabled: !!flags.canPaste },
        { role: 'selectAll', enabled: flags.canSelectAll !== false }
      )
    } else {
      if (canCopySelection) template.push({ role: 'copy', enabled: true })
      if (hasText(linkURL)) {
        if (template.length) template.push({ type: 'separator' })
        if (opts.openLinkInNewTab) {
          template.push({
            label: 'Open Link in New Tab',
            click: () => opts.openLinkInNewTab?.(linkURL)
          })
        }
        template.push({
          label: 'Copy Link Address',
          click: () => clipboard.writeText(linkURL)
        })
      }
      if (template.length) template.push({ type: 'separator' })
      template.push({ role: 'selectAll', enabled: flags.canSelectAll !== false })
    }

    if (opts.inspectElement && typeof params.x === 'number' && typeof params.y === 'number') {
      template.push(
        { type: 'separator' },
        {
          label: 'Inspect Element',
          click: () => webContents.inspectElement(params.x!, params.y!)
        }
      )
    }

    const normalized = template.filter((item, index, arr) => {
      if (item.type !== 'separator') return true
      const prev = arr[index - 1]
      const next = arr[index + 1]
      return !!prev && !!next && prev.type !== 'separator' && next.type !== 'separator'
    })

    if (normalized.length === 0) return
    event.preventDefault()
    Menu.buildFromTemplate(normalized).popup()
  })
}
