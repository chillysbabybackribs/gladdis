import type { AppCommand } from './appCommand'

export type AppMenuPlatform = 'darwin' | 'win32' | 'linux'

/** Native edit/view/window roles delegated to the focused WebContents or shell window. */
export type MenuRole =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'reload'
  | 'toggleDevTools'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'quit'

export type MenuAction =
  | { kind: 'role'; role: MenuRole }
  | { kind: 'app'; command: AppCommand }
  | { kind: 'new-folder' }
  | { kind: 'open-folder' }
  | { kind: 'toggle-fullscreen' }

export type AppMenuEntry =
  | { type: 'separator' }
  | {
      type: 'item'
      label: string
      accelerator?: string
      /** When true, item is disabled until a workspace folder is set. */
      requiresWorkspace?: boolean
      action: MenuAction
    }
  | {
      type: 'submenu'
      label: string
      requiresWorkspace?: boolean
      items: AppMenuEntry[]
    }

export type AppMenuGroup = {
  label: string
  items: AppMenuEntry[]
}

function isMac(platform: AppMenuPlatform): boolean {
  return platform === 'darwin'
}

/** Single source of truth for File / Memory / Edit / View / Window menus. */
export function getAppMenuGroups(platform: AppMenuPlatform): AppMenuGroup[] {
  const mac = isMac(platform)
  return [
    {
      label: 'File',
      items: [
        {
          type: 'item',
          label: 'New Folder...',
          accelerator: 'CmdOrCtrl+Shift+N',
          action: { kind: 'new-folder' }
        },
        {
          type: 'item',
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          action: { kind: 'open-folder' }
        },
        { type: 'separator' },
        {
          type: 'submenu',
          label: 'Start Codex in Terminal',
          requiresWorkspace: true,
          items: [
            {
              type: 'item',
              label: 'Standard',
              accelerator: 'CmdOrCtrl+Alt+C',
              action: { kind: 'app', command: { type: 'terminal:run', command: 'codex' } }
            },
            {
              type: 'item',
              label: 'Unrestricted (--yolo)',
              action: { kind: 'app', command: { type: 'terminal:run', command: 'codex --yolo' } }
            }
          ]
        },
        {
          type: 'submenu',
          label: 'Start Claude Code in Terminal',
          requiresWorkspace: true,
          items: [
            {
              type: 'item',
              label: 'Standard',
              accelerator: 'CmdOrCtrl+Alt+L',
              action: { kind: 'app', command: { type: 'terminal:run', command: 'claude' } }
            },
            {
              type: 'item',
              label: 'Unrestricted (--dangerously-skip-permissions)',
              action: {
                kind: 'app',
                command: { type: 'terminal:run', command: 'claude --dangerously-skip-permissions' }
              }
            }
          ]
        },
        { type: 'separator' },
        {
          type: 'item',
          label: mac ? 'Close Window' : 'Quit',
          accelerator: mac ? 'CmdOrCtrl+W' : 'CmdOrCtrl+Q',
          action: { kind: 'role', role: mac ? 'close' : 'quit' }
        }
      ]
    },
    {
      label: 'Memory',
      items: [
        {
          type: 'item',
          label: 'Curate Memory...',
          requiresWorkspace: true,
          action: { kind: 'app', command: { type: 'memory:open', section: 'curate' } }
        },
        {
          type: 'item',
          label: 'Review Last Dream...',
          requiresWorkspace: true,
          action: { kind: 'app', command: { type: 'memory:open', section: 'review' } }
        },
        {
          type: 'item',
          label: 'Dream History...',
          requiresWorkspace: true,
          action: { kind: 'app', command: { type: 'memory:open', section: 'history' } }
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Auto-dream Settings...',
          requiresWorkspace: true,
          action: { kind: 'app', command: { type: 'memory:open', section: 'auto' } }
        }
      ]
    },
    {
      label: 'Edit',
      items: [
        { type: 'item', label: 'Undo', accelerator: 'CmdOrCtrl+Z', action: { kind: 'role', role: 'undo' } },
        { type: 'item', label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', action: { kind: 'role', role: 'redo' } },
        { type: 'separator' },
        { type: 'item', label: 'Cut', accelerator: 'CmdOrCtrl+X', action: { kind: 'role', role: 'cut' } },
        { type: 'item', label: 'Copy', accelerator: 'CmdOrCtrl+C', action: { kind: 'role', role: 'copy' } },
        { type: 'item', label: 'Paste', accelerator: 'CmdOrCtrl+V', action: { kind: 'role', role: 'paste' } },
        {
          type: 'item',
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          action: { kind: 'role', role: 'selectAll' }
        }
      ]
    },
    {
      label: 'View',
      items: [
        {
          type: 'item',
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          action: { kind: 'role', role: 'reload' }
        },
        {
          type: 'item',
          label: 'Toggle Developer Tools',
          accelerator: mac ? 'Alt+CmdOrCtrl+I' : 'CmdOrCtrl+Shift+I',
          action: { kind: 'role', role: 'toggleDevTools' }
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          action: { kind: 'role', role: 'resetZoom' }
        },
        {
          type: 'item',
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          action: { kind: 'role', role: 'zoomIn' }
        },
        {
          type: 'item',
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          action: { kind: 'role', role: 'zoomOut' }
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Chat Left  -',
          accelerator: 'CmdOrCtrl+Shift+[',
          action: { kind: 'app', command: { type: 'chat:zoom', panel: 'left', action: 'out' } }
        },
        {
          type: 'item',
          label: 'Chat Left  +',
          accelerator: 'CmdOrCtrl+Shift+]',
          action: { kind: 'app', command: { type: 'chat:zoom', panel: 'left', action: 'in' } }
        },
        {
          type: 'item',
          label: 'Chat Left  Reset',
          accelerator: 'CmdOrCtrl+Shift+\\',
          action: { kind: 'app', command: { type: 'chat:zoom', panel: 'left', action: 'reset' } }
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Chat Right  -',
          accelerator: 'CmdOrCtrl+Alt+[',
          action: { kind: 'app', command: { type: 'chat:zoom', panel: 'right', action: 'out' } }
        },
        {
          type: 'item',
          label: 'Chat Right  +',
          accelerator: 'CmdOrCtrl+Alt+]',
          action: { kind: 'app', command: { type: 'chat:zoom', panel: 'right', action: 'in' } }
        },
        {
          type: 'item',
          label: 'Chat Right  Reset',
          accelerator: 'CmdOrCtrl+Alt+\\',
          action: { kind: 'app', command: { type: 'chat:zoom', panel: 'right', action: 'reset' } }
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Browser  -',
          accelerator: 'CmdOrCtrl+Shift+Alt+[',
          action: { kind: 'app', command: { type: 'browser:zoom', action: 'out' } }
        },
        {
          type: 'item',
          label: 'Browser  +',
          accelerator: 'CmdOrCtrl+Shift+Alt+]',
          action: { kind: 'app', command: { type: 'browser:zoom', action: 'in' } }
        },
        {
          type: 'item',
          label: 'Browser  Reset',
          accelerator: 'CmdOrCtrl+Shift+Alt+\\',
          action: { kind: 'app', command: { type: 'browser:zoom', action: 'reset' } }
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Toggle Full Screen',
          accelerator: mac ? 'Ctrl+CmdOrCtrl+F' : 'F11',
          action: { kind: 'toggle-fullscreen' }
        }
      ]
    },
    {
      label: 'Window',
      items: [
        {
          type: 'item',
          label: 'Minimize',
          accelerator: 'CmdOrCtrl+M',
          action: { kind: 'role', role: 'minimize' }
        },
        {
          type: 'item',
          label: mac ? 'Zoom' : 'Maximize',
          action: { kind: 'role', role: 'zoom' }
        }
      ]
    }
  ]
}

/** Pretty-print Electron accelerators for menu labels in the renderer. */
export function formatMenuAccelerator(platform: AppMenuPlatform, raw?: string): string | undefined {
  if (!raw) return undefined
  const mac = isMac(platform)
  return raw
    .replace(/CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/CommandOrControl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .replace(/Plus/g, '+')
    .replace(/\\/g, '\\')
}
