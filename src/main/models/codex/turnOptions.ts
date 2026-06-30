import type { CodexAppServer } from './CodexAppServer'
import type {
  CodexModelEntry,
  JsonValue,
  ReasoningEffort,
  ReasoningSummary,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams
} from './protocol'

const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
const REASONING_SUMMARIES: ReasoningSummary[] = ['none', 'auto', 'concise', 'detailed']
const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = 'medium'
const DEFAULT_CODEX_REASONING_SUMMARY: ReasoningSummary = 'none'

export function serviceTierForModel(modelId: string): string | null {
  const configured = optionalEnv('GLADDIS_CODEX_SERVICE_TIER') ?? 'fast'
  if (!configured) return null
  // Official fast mode currently applies to GPT-5.5 and GPT-5.4. Leave other
  // models alone unless the user explicitly overrides the tier.
  if (!process.env.GLADDIS_CODEX_SERVICE_TIER && configured === 'fast') {
    return modelId === 'gpt-5.5' || modelId === 'gpt-5.4' ? 'fast' : null
  }
  return configured
}

export function turnReasoningOverrides(entry?: CodexModelEntry): Pick<TurnStartParams, 'effort' | 'summary'> {
  const effort = reasoningEffortForModel(entry)
  const summary =
    enumEnv<ReasoningSummary>('GLADDIS_CODEX_REASONING_SUMMARY', REASONING_SUMMARIES) ??
    DEFAULT_CODEX_REASONING_SUMMARY
  return { ...(effort ? { effort } : {}), ...(summary ? { summary } : {}) }
}

function isOptimizationRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /\b(?:serviceTier|service_tier|fast_mode|effort|summary|reasoning|unsupported|invalid|unknown field|required experimentalApi)\b/i.test(
    message
  )
}

export async function requestWithOptimizationFallback(
  server: CodexAppServer,
  method: 'thread/start' | 'thread/resume' | 'turn/start',
  params: ThreadStartParams | ThreadResumeParams | TurnStartParams
): Promise<JsonValue> {
  try {
    return await server.request(method, params)
  } catch (err) {
    if (!isOptimizationRejection(err)) throw err
    const fallback = stripOptimizationOverrides(params)
    if (JSON.stringify(fallback) === JSON.stringify(params)) throw err
    console.warn(
      `[codex] ${method} rejected optimized settings; retrying without speed/reasoning overrides:`,
      err instanceof Error ? err.message : err
    )
    return server.request(method, fallback)
  }
}

function stripOptimizationOverrides<T extends ThreadStartParams | ThreadResumeParams | TurnStartParams>(
  params: T
): T {
  const next: any = { ...params }
  delete next.serviceTier
  delete next.effort
  delete next.summary
  if (next.config && typeof next.config === 'object') {
    const config = { ...(next.config as Record<string, JsonValue>) }
    delete config.service_tier
    if (config.features && typeof config.features === 'object' && !Array.isArray(config.features)) {
      const features = { ...(config.features as Record<string, JsonValue>) }
      delete features.fast_mode
      config.features = features
    }
    next.config = config
  }
  return next
}

function reasoningEffortForModel(entry?: CodexModelEntry): ReasoningEffort | null {
  const configured = enumEnv<ReasoningEffort>('GLADDIS_CODEX_REASONING_EFFORT', REASONING_EFFORTS)
  const supported = supportedReasoningEfforts(entry)
  if (configured) {
    return supported.length === 0 || supported.includes(configured) ? configured : supported[0]
  }
  // No override: honor the model's own advertised default reasoning effort, so we
  // match Codex's native per-model recommendation instead of pinning every model
  // to a hardcoded tier. Fall back to medium only when the model advertises none.
  const target =
    (entry?.defaultReasoningEffort && REASONING_EFFORTS.includes(entry.defaultReasoningEffort)
      ? entry.defaultReasoningEffort
      : DEFAULT_CODEX_REASONING_EFFORT)
  return pickClosestEffort(supported, target)
}

/**
 * Choose the supported effort nearest the target: exact match if available,
 * otherwise the highest supported tier at or below the target, otherwise the
 * lowest supported above it. Falls back to the target when nothing is advertised.
 */
function pickClosestEffort(supported: ReasoningEffort[], target: ReasoningEffort): ReasoningEffort {
  if (supported.length === 0) return target
  if (supported.includes(target)) return target
  const targetRank = REASONING_EFFORTS.indexOf(target)
  const atOrBelow = supported.filter((e) => REASONING_EFFORTS.indexOf(e) <= targetRank)
  if (atOrBelow.length) return atOrBelow[atOrBelow.length - 1]
  return supported[0]
}

function supportedReasoningEfforts(entry?: CodexModelEntry): ReasoningEffort[] {
  const advertised = entry?.supportedReasoningEfforts ?? []
  return advertised
    .map((item) => item?.reasoningEffort)
    .filter((effort): effort is ReasoningEffort => !!effort && REASONING_EFFORTS.includes(effort))
    .sort((a, b) => REASONING_EFFORTS.indexOf(a) - REASONING_EFFORTS.indexOf(b))
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  if (!value || /^(?:0|false|off|none)$/i.test(value)) return null
  return value
}

function enumEnv<T extends string>(name: string, allowed: readonly T[]): T | null {
  const value = optionalEnv(name)
  if (!value) return null
  const normalized = value.toLowerCase()
  return allowed.find((item) => item.toLowerCase() === normalized) ?? null
}
