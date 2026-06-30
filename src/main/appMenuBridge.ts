import { app, type BaseWindow, type MenuItemConstructorOptions, Menu, webContents } from 'electron'
import type { WebContents } from 'electron'
import {
  type AppMenuPlatform,
  type AppMenuEntry,
  type MenuAction,
  type MenuRole,
  getAppMenuGroups
} from '../../shared/appMenu'
import type { AppCommand } from '../../shared/appCommand'

export type AppMenuBridgeDeps = {
  getHasWorkspace: () => boolean
  sendAppCommand: (command: AppCommand) => void
  promptCreateWorkspaceFolder: () => Promise<void>
  openWorkspaceFolder: () => void
  toggleWindowFullScreen: () => void
  getShellWebContents: () => WebContents
  getWindow: () => BaseWindow
}

function entryEnabled(entry: AppMenuEntry, hasWorkspace: boolean): boolean {
  if (entry.type === 'separator') return true
  if (!entry.requiresWorkspace) return true
  return hasWorkspace
}

function resolveTargetWebContents(shell: WebContents): WebContents {
  const focused = webContents.getFocusedWebContents()
  if (focused && !focused.isDestroyed()) return focused
  return shell
}

export function invokeMenuRole(role: MenuRole, deps: AppMenuBridgeDeps): void {
  const win = deps.getWindow()
  const shell = deps.getShellWebContents()
  const target = resolveTargetWebContents(shell)

  switch (role) {
    case 'undo':
      target.undo()
      return
    case 'redo':
      target.redo()
      return
    case 'cut':
      target.cut()
      return
    case 'copy':
      target.copy()
      return
    case 'paste':
      target.paste()
      return
    case 'selectAll':
      target.selectAll()
      return
    case 'reload':
      target.reload()
      return
    case 'toggleDevTools':
      target.toggleDevTools()
      return
    case 'resetZoom':
      target.setZoomLevel(0)
      return
    case 'zoomIn':
      target.setZoomLevel(target.getZoomLevel() + 0.5)
      return
    case 'zoomOut':
      target.setZoomLevel(target.getZoomLevel() - 0.5)
      return
    case 'minimize':
      win.minimize()
      return
    case 'zoom':
      if (process.platform === 'darwin') {
        win.isMaximized() ? win.unmaximize() : win.maximize()
      } else {
        deps.toggleWindowFullScreen()
      }
      return
    case 'close':
      win.close()
      return
    case 'quit':
      app.quit()
      return
  }
}

function runMenuAction(action: MenuAction, deps: AppMenuBridgeDeps): void {
  switch (action.kind) {
    case 'role':
      invokeMenuRole(action.role, deps)
      return
    case 'app':
      deps.sendAppCommand(action.command)
      return
    case 'new-folder':
      void deps.promptCreateWorkspaceFolder()
      return
    case 'open-folder':
      deps.openWorkspaceFolder()
      return
    case 'toggle-fullscreen':
      deps.toggleWindowFullScreen()
      return
  }
}

function toElectronEntry(entry: AppMenuEntry, deps: AppMenuBridgeDeps): MenuItemConstructorOptions | null {
  if (entry.type === 'separator') return { type: 'separator' }

  const enabled = entryEnabled(entry, deps.getHasWorkspace())

  if (entry.type === 'submenu') {
    return {
      label: entry.label,
      enabled,
      submenu: entry.items
        .map((child) => toElectronEntry(child, deps))
        .filter((child): child is MenuItemConstructorOptions => child != null)
    }
  }

  if (entry.action.kind === 'role') {
    return {
      label: entry.label,
      accelerator: entry.accelerator,
      enabled,
      role: entry.action.role as MenuItemConstructorOptions['role']
    }
  }

  return {
    label: entry.label,
    accelerator: entry.accelerator,
    enabled,
    click: () => runMenuAction(entry.action, deps)
  }
}

export function buildApplicationMenuTemplate(deps: AppMenuBridgeDeps): MenuItemConstructorOptions[] {
  return getAppMenuGroups(process.platform as AppMenuPlatform).map((group) => ({
    label: group.label,
    submenu: group.items
      .map((entry) => toElectronEntry(entry, deps))
      .filter((entry): entry is MenuItemConstructorOptions => entry != null)
  }))
}

export function setApplicationMenu(deps: AppMenuBridgeDeps): Menu {
  const menu = Menu.buildFromTemplate(buildApplicationMenuTemplate(deps))
  Menu.setApplicationMenu(menu)
  return menu
}
