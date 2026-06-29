import { writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  Menu,
  clipboard,
  dialog,
  nativeImage,
  type MenuItemConstructorOptions,
  type WebContents,
  type Event
} from 'electron'

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
  mediaType?: string
  srcURL?: string
  x?: number
  y?: number
}

function hasText(value: string | undefined): value is string {
  return !!value && value.trim().length > 0
}

function imageExtensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/bmp':
      return 'bmp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'png'
  }
}

function parseDataUrl(value: string): { buffer: Buffer; mime: string; extension: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) return null

  const mime = match[1] || 'application/octet-stream'
  const isBase64 = !!match[2]
  const payload = match[3] || ''
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  return { buffer, mime, extension: imageExtensionForMime(mime) }
}

function defaultImageName(srcURL: string, extension: string): string {
  if (srcURL.startsWith('data:')) return `image.${extension}`

  try {
    const url = new URL(srcURL)
    const name = basename(url.pathname)
    if (name) return extname(name) ? name : `${name}.${extension}`
  } catch {
    // Fall through to a stable default.
  }

  return `image.${extension}`
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
    const srcURL = params.srcURL ?? ''
    const flags = params.editFlags ?? {}
    const canCopySelection = hasText(selectionText) && flags.canCopy !== false
    const isImage = params.mediaType === 'image' && hasText(srcURL)

    template.push(
      { role: 'undo', enabled: !!flags.canUndo },
      { role: 'redo', enabled: !!flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: !!flags.canCut },
      { role: 'copy', enabled: params.isEditable ? !!flags.canCopy : canCopySelection },
      { role: 'paste', enabled: !!flags.canPaste },
      { role: 'selectAll', enabled: flags.canSelectAll !== false }
    )

    if (isImage) {
      template.push(
        { type: 'separator' },
        {
          label: 'Copy Image',
          enabled: srcURL.startsWith('data:image/'),
          click: () => {
            const image = nativeImage.createFromDataURL(srcURL)
            if (!image.isEmpty()) clipboard.writeImage(image)
          }
        },
        {
          label: 'Save Image As...',
          click: async () => {
            const parsed = parseDataUrl(srcURL)
            if (!parsed) {
              webContents.downloadURL(srcURL)
              return
            }

            const { canceled, filePath } = await dialog.showSaveDialog({
              defaultPath: defaultImageName(srcURL, parsed.extension),
              filters: [{ name: parsed.mime, extensions: [parsed.extension] }]
            })
            if (canceled || !filePath) return
            await writeFile(filePath, parsed.buffer)
          }
        }
      )
    }

    if (!params.isEditable && hasText(linkURL)) {
      template.push({ type: 'separator' })
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
