import type { ThreadItem } from './protocol'

/** Tool-ish ThreadItem types we surface as gladdis tool chips. */
export const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageGeneration'
])

/**
 * A `gladdis.*` dynamic-tool call. Its chip is emitted (and the tool actually
 * run) by respondToCodexBrowserToolCall, so the generic item-lifecycle path must
 * NOT also chip it — otherwise every browser tool shows up twice.
 */
export function isGladdisDynamicToolCall(item: ThreadItem): boolean {
  return item?.type === 'dynamicToolCall' && (item as any).namespace === 'gladdis'
}

export function codexToolName(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution':
      return 'shell'
    case 'fileChange':
      return 'edit_file'
    case 'webSearch':
      return 'web_search'
    case 'mcpToolCall':
      return `mcp:${(item as any).tool ?? 'tool'}`
    case 'dynamicToolCall':
      return String((item as any).tool ?? 'tool')
    case 'imageGeneration':
      return 'image'
    default:
      return String(item.type)
  }
}

export function toolArgs(item: ThreadItem): unknown {
  switch (item.type) {
    case 'commandExecution':
      return { command: (item as any).command, cwd: (item as any).cwd }
    case 'fileChange':
      return { changes: (item as any).changes }
    case 'webSearch':
      return { query: (item as any).query }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return (item as any).arguments
    default:
      return {}
  }
}

export function toolOk(item: ThreadItem): boolean {
  switch (item.type) {
    case 'commandExecution': {
      const code = (item as any).exitCode
      return code === 0 || code === null || code === undefined
    }
    case 'fileChange':
      return (item as any).status !== 'failed'
    case 'mcpToolCall':
      return (item as any).error == null
    case 'dynamicToolCall':
      return (item as any).success !== false
    default:
      return true
  }
}

export function toolPreview(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution': {
      const out = (item as any).aggregatedOutput
      if (typeof out === 'string' && out.trim()) return out.slice(0, 200)
      return `exit ${(item as any).exitCode ?? '?'}`
    }
    case 'fileChange': {
      const changes = (item as any).changes
      const n = Array.isArray(changes) ? changes.length : 0
      return `${n} file change(s) — ${(item as any).status ?? 'applied'}`
    }
    case 'webSearch':
      return `searched: ${(item as any).query ?? ''}`.slice(0, 200)
    default:
      return String(item.type)
  }
}
