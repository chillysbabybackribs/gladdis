export type NetworkFilterSpec = {
  mode: 'substring' | 'regex' | 'any'
  label?: string
  substring?: string
  regex?: string
  patterns?: string[]
  resourceTypes?: string[]
  statusCodes?: number[]
  statusMin?: number
  statusMax?: number
  mimeIncludes?: string[]
}

export type CapturedNetworkRequest = {
  requestId: string
  url: string
  method: string
  status: number
  mimeType: string
  type: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody?: string
  requestBodyTruncated?: boolean
  startedAt?: number
  responseReceivedAt?: number
  finishedAt?: number
  durationMs?: number
  encodedDataLength?: number
  success: boolean
  errorText?: string
}

export type CapturedNetworkBody = {
  requestId: string
  url: string
  status: number
  mimeType: string
  body: string
  truncated: boolean
}

type CapturedNetworkBodyState = CapturedNetworkBody & {
  claimedAt: number
}

export type WatchNetworkOptions = {
  urlFilter?: string
  urlFilters?: string[]
  urlRegex?: string
  resourceTypes?: string[]
  statusCodes?: number[]
  statusMin?: number
  statusMax?: number
  mimeIncludes?: string[]
  includeRequestBody?: boolean
  redactSensitive?: boolean
  windowMs: number
  maxBodies: number
  maxBodyChars: number
}

type CreateWatchNetworkRecorderOptions = {
  filter?: NetworkFilterSpec
  includeRequestBody?: boolean
  redactSensitive?: boolean
  maxBodies: number
  maxBodyChars: number
  getResponseBody: (requestId: string) => Promise<{ body: string; base64Encoded: boolean }>
  getRequestPostData?: (requestId: string) => Promise<{ postData: string }>
}

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token'
])

const SENSITIVE_FIELD_PATTERN = /(authorization|token|access_token|refresh_token|id_token|api_?key|secret|password|passwd|session|cookie|bearer)/i

function isDataType(type: string, mime: string): boolean {
  const normalizedType = (type || '').toLowerCase()
  if (normalizedType === 'xhr' || normalizedType === 'fetch') return true
  return /json|javascript|text\/plain/.test((mime || '').toLowerCase()) && normalizedType !== 'script'
}

function normalizeHeaderMap(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined) continue
    out[String(key)] = typeof value === 'string' ? value : String(value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function redactHeaderMap(headers: Record<string, string> | undefined, enabled: boolean): Record<string, string> | undefined {
  if (!headers) return undefined
  if (!enabled) return headers
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value
  }
  return out
}

function truncateText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: value.slice(0, maxChars), truncated: true }
}

function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : redactStructuredValue(inner)
  }
  return out
}

function redactTextPatterns(text: string): string {
  return text
    .replace(/((?:authorization|token|access_token|refresh_token|id_token|api_?key|secret|password|passwd|session|cookie)=)([^&\s]+)/gi, '$1[REDACTED]')
    .replace(/("(?:authorization|token|access_token|refresh_token|id_token|api_?key|secret|password|passwd|session|cookie)"\s*:\s*")([^"]*)"/gi, '$1[REDACTED]"')
}

function redactBodyText(body: string, enabled: boolean): string {
  if (!enabled || !body) return body

  try {
    const parsed = JSON.parse(body)
    return JSON.stringify(redactStructuredValue(parsed), null, 2)
  } catch {
    // fall through
  }

  try {
    const params = new URLSearchParams(body)
    let changed = false
    for (const key of [...params.keys()]) {
      if (!SENSITIVE_FIELD_PATTERN.test(key)) continue
      params.set(key, '[REDACTED]')
      changed = true
    }
    if (changed) return params.toString()
  } catch {
    // fall through
  }

  return redactTextPatterns(body)
}

function matchesMetadataFilter(record: CapturedNetworkRequest, filter?: NetworkFilterSpec): boolean {
  const resourceTypes = filter?.resourceTypes ?? []
  if (resourceTypes.length > 0) {
    const recordType = (record.type || '').toLowerCase()
    if (!resourceTypes.includes(recordType)) return false
  }

  const statusCodes = filter?.statusCodes ?? []
  if (statusCodes.length > 0 && !statusCodes.includes(record.status)) {
    return false
  }

  if (typeof filter?.statusMin === 'number' && record.status < filter.statusMin) {
    return false
  }
  if (typeof filter?.statusMax === 'number' && record.status > filter.statusMax) {
    return false
  }

  const mimeIncludes = filter?.mimeIncludes ?? []
  if (mimeIncludes.length > 0) {
    const mime = (record.mimeType || '').toLowerCase()
    if (!mimeIncludes.some((part) => mime.includes(part))) return false
  }

  return true
}

export function buildNetworkFilter(opts: Omit<WatchNetworkOptions, 'windowMs' | 'maxBodies' | 'maxBodyChars'>): NetworkFilterSpec | undefined {
  const regex = typeof opts.urlRegex === 'string' ? opts.urlRegex.trim() : ''
  const patterns = Array.isArray(opts.urlFilters)
    ? opts.urlFilters.map((value) => String(value).trim()).filter(Boolean)
    : []
  const substring = typeof opts.urlFilter === 'string' ? opts.urlFilter.trim() : ''
  const resourceTypes = Array.isArray(opts.resourceTypes)
    ? opts.resourceTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : []
  const statusCodes = Array.isArray(opts.statusCodes)
    ? opts.statusCodes
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 100 && value <= 599)
        .map((value) => Math.trunc(value))
    : []
  const statusMin =
    typeof opts.statusMin === 'number' && Number.isFinite(opts.statusMin) ? Math.trunc(opts.statusMin) : undefined
  const statusMax =
    typeof opts.statusMax === 'number' && Number.isFinite(opts.statusMax) ? Math.trunc(opts.statusMax) : undefined
  const mimeIncludes = Array.isArray(opts.mimeIncludes)
    ? opts.mimeIncludes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : []

  const labels: string[] = []
  let mode: NetworkFilterSpec['mode'] = 'substring'
  let hasUrlFilter = false

  if (regex) {
    mode = 'regex'
    hasUrlFilter = true
    labels.push(`url~/${regex}/i`)
  } else if (patterns.length > 0) {
    mode = 'any'
    hasUrlFilter = true
    labels.push(`url contains any(${patterns.join(', ')})`)
  } else if (substring) {
    mode = 'substring'
    hasUrlFilter = true
    labels.push(`url contains ${substring}`)
  }

  if (resourceTypes.length > 0) labels.push(`type in [${resourceTypes.join(', ')}]`)
  if (statusCodes.length > 0) labels.push(`status in [${statusCodes.join(', ')}]`)
  if (statusMin !== undefined) labels.push(`status >= ${statusMin}`)
  if (statusMax !== undefined) labels.push(`status <= ${statusMax}`)
  if (mimeIncludes.length > 0) labels.push(`mime includes any(${mimeIncludes.join(', ')})`)

  if (!hasUrlFilter && resourceTypes.length === 0 && statusCodes.length === 0 && statusMin === undefined && statusMax === undefined && mimeIncludes.length === 0) {
    return undefined
  }

  return {
    mode,
    label: labels.join('; '),
    substring: substring ? substring.toLowerCase() : undefined,
    regex: regex || undefined,
    patterns: patterns.length > 0 ? patterns : undefined,
    resourceTypes: resourceTypes.length > 0 ? resourceTypes : undefined,
    statusCodes: statusCodes.length > 0 ? statusCodes : undefined,
    statusMin,
    statusMax,
    mimeIncludes: mimeIncludes.length > 0 ? mimeIncludes : undefined
  }
}

export function matchesNetworkFilter(url: string, filter?: NetworkFilterSpec): boolean {
  if (!filter) return true
  const value = String(url ?? '')
  const lower = value.toLowerCase()
  if (filter.mode === 'substring') {
    return !!filter.substring && lower.includes(filter.substring)
  }
  if (filter.mode === 'any') {
    return (filter.patterns ?? []).some((pattern) => lower.includes(pattern.toLowerCase()))
  }
  if (filter.mode === 'regex') {
    try {
      return new RegExp(filter.regex ?? '', 'i').test(value)
    } catch {
      return true
    }
  }
  return true
}

export function createWatchNetworkRecorder(options: CreateWatchNetworkRecorderOptions) {
  const requests = new Map<string, CapturedNetworkRequest>()
  const bodyStates = new Map<string, CapturedNetworkBodyState>()
  const bodyClaimOrder: string[] = []
  let lastActivityAt: number | null = null

  const markActivity = (): void => {
    lastActivityAt = Date.now()
  }

  const ensureRequest = (requestId: string, seed?: Partial<CapturedNetworkRequest>): CapturedNetworkRequest => {
    const existing = requests.get(requestId)
    if (existing) {
      if (seed) Object.assign(existing, seed)
      return existing
    }
    const created: CapturedNetworkRequest = {
      requestId,
      url: seed?.url ?? '',
      method: seed?.method ?? 'GET',
      status: seed?.status ?? 0,
      mimeType: seed?.mimeType ?? '',
      type: seed?.type ?? '',
      requestHeaders: seed?.requestHeaders,
      responseHeaders: seed?.responseHeaders,
      startedAt: seed?.startedAt,
      responseReceivedAt: seed?.responseReceivedAt,
      finishedAt: seed?.finishedAt,
      durationMs: seed?.durationMs,
      encodedDataLength: seed?.encodedDataLength,
      success: seed?.success ?? false,
      errorText: seed?.errorText
    }
    requests.set(requestId, created)
    return created
  }

  const maybeFinalizeDuration = (record: CapturedNetworkRequest): void => {
    if (record.startedAt !== undefined && record.finishedAt !== undefined) {
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt)
    }
  }

  const canCaptureBody = (record: CapturedNetworkRequest): boolean =>
    matchesMetadataFilter(record, options.filter) && isDataType(record.type, record.mimeType) && record.status >= 200 && record.status < 400

  const canCaptureRequestBody = (record: CapturedNetworkRequest): boolean => {
    if (!options.includeRequestBody) return false
    const method = (record.method || '').toUpperCase()
    return method !== 'GET' && method !== 'HEAD'
  }

  const claimBodySlot = (requestId: string): boolean => {
    if (bodyStates.has(requestId)) return true
    if (bodyClaimOrder.includes(requestId)) return true
    if (bodyClaimOrder.length >= options.maxBodies) return false
    bodyClaimOrder.push(requestId)
    return true
  }

  const releaseBodySlot = (requestId: string): void => {
    const index = bodyClaimOrder.indexOf(requestId)
    if (index >= 0) bodyClaimOrder.splice(index, 1)
  }

  const captureResponseBody = async (requestId: string): Promise<void> => {
    if (bodyStates.has(requestId)) return
    const record = requests.get(requestId)
    if (!record || !canCaptureBody(record)) return
    if (!claimBodySlot(requestId)) return
    try {
      const res = await options.getResponseBody(requestId)
      const rawBody = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body
      const redactedBody = redactBodyText(rawBody, options.redactSensitive !== false)
      const { value: body, truncated } = truncateText(redactedBody, options.maxBodyChars)
      bodyStates.set(requestId, {
        requestId,
        url: record.url,
        status: record.status,
        mimeType: record.mimeType,
        body,
        truncated,
        claimedAt: Date.now()
      })
    } catch {
      releaseBodySlot(requestId)
      // Body may already be gone or unavailable; keep metadata and allow fallback recovery.
    }
  }

  const maybeStoreRequestBody = async (requestId: string, body: unknown): Promise<void> => {
    const record = requests.get(requestId)
    if (!record || record.requestBody !== undefined || !canCaptureRequestBody(record)) return

    const rawBody = typeof body === 'string' ? body : ''
    if (rawBody) {
      const redactedBody = redactBodyText(rawBody, options.redactSensitive !== false)
      const truncated = truncateText(redactedBody, options.maxBodyChars)
      record.requestBody = truncated.value
      record.requestBodyTruncated = truncated.truncated
      return
    }

    if (!options.getRequestPostData) return
    try {
      const res = await options.getRequestPostData(requestId)
      const redactedBody = redactBodyText(String(res.postData ?? ''), options.redactSensitive !== false)
      const truncated = truncateText(redactedBody, options.maxBodyChars)
      record.requestBody = truncated.value
      record.requestBodyTruncated = truncated.truncated
    } catch {
      // Request post data is best-effort and often unavailable after the fact.
    }
  }

  return {
    onMessage(method: string, params: any): void {
      try {
        if (method === 'Network.requestWillBeSent') {
          const requestId = String(params?.requestId ?? '')
          const request = params?.request ?? {}
          const url = String(request.url ?? '')
          if (!requestId || !matchesNetworkFilter(url, options.filter)) return
          markActivity()
          ensureRequest(requestId, {
            requestId,
            url,
            method: String(request.method ?? 'GET'),
            type: String(params?.type ?? ''),
            startedAt: typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now(),
            requestHeaders: redactHeaderMap(normalizeHeaderMap(request.headers), options.redactSensitive !== false)
          })
          void maybeStoreRequestBody(requestId, request.postData)
          return
        }

        if (method === 'Network.responseReceived') {
          const requestId = String(params?.requestId ?? '')
          const response = params?.response ?? {}
          const url = String(response.url ?? '')
          if (!requestId || !matchesNetworkFilter(url, options.filter)) return
          markActivity()
          const record = ensureRequest(requestId, {
            requestId,
            url,
            type: String(params?.type ?? ''),
            status: Number(response.status ?? 0),
            mimeType: String(response.mimeType ?? ''),
            responseReceivedAt: typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now(),
            responseHeaders: redactHeaderMap(normalizeHeaderMap(response.headers), options.redactSensitive !== false)
          })
          if (!record.method || record.method === 'GET') {
            const pseudoMethod = response?.requestHeaders?.[':method'] ?? response?.requestHeaders?.method
            if (pseudoMethod) record.method = String(pseudoMethod)
          }
          if (!record.requestHeaders) {
            record.requestHeaders = redactHeaderMap(normalizeHeaderMap(response.requestHeaders), options.redactSensitive !== false)
          }
          return
        }

        if (method === 'Network.loadingFinished') {
          const requestId = String(params?.requestId ?? '')
          const record = requests.get(requestId)
          if (!record) return
          markActivity()
          record.finishedAt = typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
          record.encodedDataLength = Number.isFinite(params?.encodedDataLength)
            ? Number(params.encodedDataLength)
            : record.encodedDataLength
          record.success = true
          maybeFinalizeDuration(record)
          void captureResponseBody(requestId)
          return
        }

        if (method === 'Network.loadingFailed') {
          const requestId = String(params?.requestId ?? '')
          const record = requests.get(requestId)
          if (!record) return
          markActivity()
          record.finishedAt = typeof params?.timestamp === 'number' ? params.timestamp * 1000 : Date.now()
          record.success = false
          record.errorText = typeof params?.errorText === 'string' ? params.errorText : 'Network loading failed'
          maybeFinalizeDuration(record)
        }
      } catch {
        /* a single malformed event must not break the capture */
      }
    },

    getSnapshot(): { totalSeen: number; lastActivityAt: number | null } {
      return { totalSeen: requests.size, lastActivityAt }
    },

    async finalize(): Promise<{
      captured: CapturedNetworkRequest[]
      totalSeen: number
      bodies: CapturedNetworkBody[]
    }> {
      const captured = [...requests.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      if (options.includeRequestBody) {
        await Promise.all(captured.map((record) => maybeStoreRequestBody(record.requestId, undefined)))
      }
      const candidates = captured.filter((record) => canCaptureBody(record))
      for (const record of candidates) {
        if (bodyClaimOrder.length >= options.maxBodies) break
        await captureResponseBody(record.requestId)
      }

      const bodies = bodyClaimOrder
        .map((requestId) => bodyStates.get(requestId))
        .filter((value): value is CapturedNetworkBodyState => Boolean(value))
        .map(({ claimedAt: _claimedAt, ...body }) => body)

      return { captured, totalSeen: captured.length, bodies }
    }
  }
}
