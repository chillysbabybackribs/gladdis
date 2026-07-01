import type {
  CapturedNetworkBody,
  CapturedNetworkRequest,
  NetworkFilterSpec
} from './watchNetworkRecorder'

export type DataSourceKind = 'json' | 'graphql' | 'html' | 'other'
export type NetworkAuthKind = 'none' | 'cookie' | 'header' | 'unknown'
export type PageDataMode = 'server_rendered' | 'api_backed' | 'mixed' | 'unknown'

export interface DataSourceCandidate {
  url: string
  method: string
  status: number
  type: string
  mimeType: string
  kind: DataSourceKind
  auth: NetworkAuthKind
  score: number
  durationMs?: number
  encodedDataLength?: number
  sampleKeys?: string[]
  requestKeys?: string[]
}

export interface NetworkAwarenessState {
  pageUrl: string
  capturedAt: number
  observedWindowMs?: number
  totalSeen: number
  matchedCount: number
  pageMode: PageDataMode
  botProtectionSuspected: boolean
  recommendation: string
  filter?: NetworkFilterSpec
  candidateApis: DataSourceCandidate[]
}

type CaptureLike = {
  totalSeen: number
  captured: CapturedNetworkRequest[]
  bodies: CapturedNetworkBody[]
  filter?: NetworkFilterSpec
}

const APIISH_URL_RE = /\b(api|graphql|query|search|feed|comments?|items?|stories?|posts?|list|data|json)\b/i
const GRAPHQL_RE = /\bgraphql\b/i
const BOT_PROTECTION_URL_RE = /\b(captcha|challenge|turnstile|verify|bot|cdn-cgi)\b/i
const BOT_PROTECTION_TEXT_RE = /\b(attention required|verify you are human|captcha|cf-chl|checking your browser)\b/i

function parseJsonKeys(body: string | undefined): string[] | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    if (Array.isArray(parsed)) {
      const first = parsed.find((item) => item && typeof item === 'object')
      if (first && !Array.isArray(first)) return Object.keys(first as Record<string, unknown>).slice(0, 8)
      return undefined
    }
    if (parsed && typeof parsed === 'object') {
      return Object.keys(parsed as Record<string, unknown>).slice(0, 8)
    }
  } catch {
    return undefined
  }
  return undefined
}

function inferAuth(record: CapturedNetworkRequest): NetworkAuthKind {
  const headers = Object.fromEntries(
    Object.entries(record.requestHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  if ('authorization' in headers || 'x-api-key' in headers || 'proxy-authorization' in headers) return 'header'
  if ('cookie' in headers) return 'cookie'
  if (Object.keys(headers).length > 0) return 'none'
  return 'unknown'
}

function inferKind(record: CapturedNetworkRequest, body: CapturedNetworkBody | undefined): DataSourceKind {
  const url = record.url || body?.url || ''
  const mime = (record.mimeType || body?.mimeType || '').toLowerCase()
  const requestBody = record.requestBody || ''
  const bodyText = body?.body || ''
  if (
    GRAPHQL_RE.test(url) ||
    /"operationName"\s*:|"query"\s*:/.test(requestBody) ||
    /"data"\s*:|"errors"\s*:/.test(bodyText)
  ) {
    return 'graphql'
  }
  if (
    mime.includes('json') ||
    mime.includes('javascript') ||
    (record.type || '').toLowerCase() === 'xhr' ||
    (record.type || '').toLowerCase() === 'fetch' ||
    parseJsonKeys(bodyText)
  ) {
    return 'json'
  }
  if (mime.includes('html') || (record.type || '').toLowerCase() === 'document') return 'html'
  return 'other'
}

function candidateScore(record: CapturedNetworkRequest, kind: DataSourceKind, auth: NetworkAuthKind): number {
  let score = 0
  if (record.success) score += 8
  if (record.status >= 200 && record.status < 400) score += 8
  if (kind === 'graphql') score += 50
  else if (kind === 'json') score += 38
  else if (kind === 'html') score += 8
  const type = (record.type || '').toLowerCase()
  if (type === 'fetch' || type === 'xhr') score += 12
  if (APIISH_URL_RE.test(record.url || '')) score += 10
  if (auth === 'header') score += 5
  if (auth === 'cookie') score += 3
  if (typeof record.encodedDataLength === 'number' && record.encodedDataLength > 0) score += 2
  if (record.status >= 400) score -= 15
  return score
}

function summarizeRecommendation(args: {
  pageMode: PageDataMode
  botProtectionSuspected: boolean
  candidateApis: DataSourceCandidate[]
  totalSeen: number
}): string {
  if (args.botProtectionSuspected) {
    return 'Bot-protection signals detected. Prefer DOM/a11y extraction or a bounded next-action capture, and avoid aggressive always-on body collection.'
  }
  if (args.pageMode === 'api_backed') {
    return 'This page looks API-backed. Prefer network/API extraction for repeated records, and arm watch_network before the next UI-changing action when you need refreshed data.'
  }
  if (args.pageMode === 'mixed') {
    return 'This page mixes server-rendered HTML with API data. Preserve the current page before leaving; use network discovery for refreshed lists and extract_structured for stable visible content.'
  }
  if (args.pageMode === 'server_rendered') {
    return 'This page looks mostly server-rendered. Prefer DOM/a11y extraction first; use network capture only around actions that likely trigger new data loads.'
  }
  if (args.totalSeen === 0) {
    return 'No requests were observed in the current window. If the page updates after user actions, arm watch_network before the next action; otherwise stay in the DOM.'
  }
  if (args.candidateApis.length > 0) {
    return 'A few candidate data endpoints were observed. If you need exact lists or comment records, capture around the next action or query the strongest endpoint directly.'
  }
  return 'No strong structured data source stood out. Prefer DOM/a11y tools unless the next user action triggers fresh network traffic.'
}

export function summarizeDataSourceDiscovery(
  capture: CaptureLike,
  opts: { pageUrl: string; capturedAt?: number; observedWindowMs?: number; maxCandidates?: number }
): NetworkAwarenessState {
  const bodyByRequestId = new Map(capture.bodies.map((body) => [body.requestId, body] as const))
  const candidates: DataSourceCandidate[] = capture.captured.map((record) => {
    const body = bodyByRequestId.get(record.requestId)
    const kind = inferKind(record, body)
    const auth = inferAuth(record)
    return {
      url: record.url,
      method: record.method,
      status: record.status,
      type: record.type,
      mimeType: record.mimeType,
      kind,
      auth,
      score: candidateScore(record, kind, auth),
      durationMs: record.durationMs,
      encodedDataLength: record.encodedDataLength,
      sampleKeys: parseJsonKeys(body?.body),
      requestKeys: parseJsonKeys(record.requestBody)
    }
  })

  const ranked = candidates
    .filter((candidate) => candidate.kind === 'graphql' || candidate.kind === 'json')
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, opts.maxCandidates ?? 5))

  const sawHtml = candidates.some((candidate) => candidate.kind === 'html')
  const sawData = ranked.length > 0
  const pageMode: PageDataMode =
    capture.totalSeen === 0
      ? 'unknown'
      : sawData && sawHtml
        ? 'mixed'
        : sawData
          ? 'api_backed'
          : 'server_rendered'

  const botProtectionSuspected =
    capture.captured.some((record) => {
      const url = record.url || ''
      if (record.status === 401 || record.status === 403 || record.status === 429 || record.status === 503) {
        return BOT_PROTECTION_URL_RE.test(url)
      }
      return false
    }) ||
    capture.bodies.some((body) => BOT_PROTECTION_TEXT_RE.test(body.body))

  return {
    pageUrl: opts.pageUrl,
    capturedAt: opts.capturedAt ?? Date.now(),
    observedWindowMs: opts.observedWindowMs,
    totalSeen: capture.totalSeen,
    matchedCount: capture.captured.length,
    pageMode,
    botProtectionSuspected,
    recommendation: summarizeRecommendation({
      pageMode,
      botProtectionSuspected,
      candidateApis: ranked,
      totalSeen: capture.totalSeen
    }),
    filter: capture.filter,
    candidateApis: ranked
  }
}

export function formatDataSourceDiscovery(summary: NetworkAwarenessState, opts?: { label?: string }): string {
  const label = opts?.label ?? 'DATA SOURCE DISCOVERY'
  const lines = [
    `${label}: ${summary.pageMode.replace(/_/g, ' ')}; ${summary.totalSeen} request(s) observed; ${summary.candidateApis.length} candidate API endpoint(s).`
  ]
  if (summary.botProtectionSuspected) lines.push('Bot protection signals: suspected.')
  if (summary.candidateApis.length > 0) {
    lines.push('Top candidates:')
    for (const candidate of summary.candidateApis.slice(0, 5)) {
      const size = typeof candidate.encodedDataLength === 'number' ? ` ${candidate.encodedDataLength}B` : ''
      const duration = typeof candidate.durationMs === 'number' ? ` ${Math.round(candidate.durationMs)}ms` : ''
      const keys = candidate.sampleKeys && candidate.sampleKeys.length > 0 ? ` keys=${candidate.sampleKeys.join(',')}` : ''
      lines.push(
        `  [${candidate.kind}] ${candidate.method} ${candidate.status} ${candidate.type} ${candidate.url}${duration}${size}${keys}`
      )
    }
  }
  lines.push(`Recommendation: ${summary.recommendation}`)
  return lines.join('\n')
}
