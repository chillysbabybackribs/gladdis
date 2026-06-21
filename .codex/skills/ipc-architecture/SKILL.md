---
name: ipc-architecture
description: Guidelines for safely extending Gladdis's Electron IPC channels and maintaining type-safety across Main, Preload, and Renderer.
requirements: electron, electron-vite
---

# Electron IPC & React Architecture Skill

This skill provides the structure and rules for safely modifying the split-pane Electron and React 19 architecture of Gladdis.

## Core Principles

1. **Strict IPC Type Safety**
   - All IPC channels must be declared and typed in `shared/types.ts` or `shared/models.ts`.
   - Never use untyped string channels in `ipcRenderer.send` or `ipcMain.handle`.
   - Ensure the return values and payloads of all IPC handlers match the TypeScript interfaces exactly.

2. **Non-Blocking IPC Handlers**
   - Main process IPC handlers (`ipcMain.handle`) must be asynchronous and should never block the main event loop.
   - For long-running operations (e.g. background browser driving), use progressive status updates sent via `webContents.send` rather than waiting for a single monolithic return.

3. **Preload Script Boundaries**
   - Keep the preload script (`src/preload/index.ts`) minimal.
   - Only expose safe, wrapped APIs via `contextBridge.exposeInMainWorld`.
   - Never expose raw Electron APIs (e.g. `ipcRenderer` directly) to the Renderer process to prevent remote code execution vulnerabilities.

4. **React 19 Rendering & State**
   - Maintain the custom dark, Tailwind-based Cursor-like UI theme.
   - Use React 19 concurrent features and native hooks safely without introducing extra render loops.
   - Keep Chat UI state (message log, selected model, tab listings) cleanly synchronized with the backend via IPC events.
