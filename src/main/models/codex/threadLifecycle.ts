import type { CodexAppServer } from './CodexAppServer'

export async function unsubscribeThread(server: CodexAppServer | null, threadId: string): Promise<void> {
  if (!server || !server.running) return
  try {
    await server.request('thread/unsubscribe', { threadId }, 10_000)
  } catch (err) {
    if (process.env.GLADDIS_CODEX_DEBUG) {
      console.warn('[codex] thread/unsubscribe failed:', err instanceof Error ? err.message : err)
    }
  }
}
