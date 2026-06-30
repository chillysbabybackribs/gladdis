import { approxInputChars } from '../ModelCallLedger'

const PREFIX_WITH_TOOLS_CACHE = new WeakMap<object, Map<string, number>>()
const PREFIX_SYSTEM_ONLY_CACHE = new Map<string, number>()
let promptPrefixComputeCount = 0

function getPromptPrefixChars(system: string, tools?: object): number {
  if (!tools) {
    const cached = PREFIX_SYSTEM_ONLY_CACHE.get(system)
    if (typeof cached === 'number') return cached
    promptPrefixComputeCount += 1
    const chars = approxInputChars({ system })
    PREFIX_SYSTEM_ONLY_CACHE.set(system, chars)
    return chars
  }

  const cachedBySystem = PREFIX_WITH_TOOLS_CACHE.get(tools)
  const cached = cachedBySystem?.get(system)
  if (typeof cached === 'number') return cached

  promptPrefixComputeCount += 1
  const chars = approxInputChars({ system, tools })
  if (cachedBySystem) cachedBySystem.set(system, chars)
  else PREFIX_WITH_TOOLS_CACHE.set(tools, new Map([[system, chars]]))
  return chars
}

export function estimatePromptInputChars(args: {
  system: string
  tools?: object
  dynamic: unknown
}): number {
  return getPromptPrefixChars(args.system, args.tools) + approxInputChars(args.dynamic)
}

export const __testInternals = {
  reset(): void {
    promptPrefixComputeCount = 0
    PREFIX_SYSTEM_ONLY_CACHE.clear()
  },
  getState(): { promptPrefixComputeCount: number } {
    return { promptPrefixComputeCount }
  }
}
