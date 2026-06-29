import type {
  CapabilityActivityEventName,
  CapabilityName,
  ChatStreamEvent,
  LoopPhase,
  LoopStateEventName
} from '../../../../shared/types'
import type { ReadSpansInput, RepoOverviewInput, RepoOverviewResult, SearchRepoInput, SearchRepoResult } from './RepoIntelligenceService'
import type { ResearchDossierInput, ResearchDossierResult } from './ResearchDossierService'
import type { ValidationCheck, VerifyChangeInput, VerifyChangeResult } from './ValidationService'

export interface BrokerCallContext {
  requestId: string
  assistantMessageId?: string
  taskId: string
  iteration?: number
}

export interface RepoOverviewArgs {
  workspaceRoot: string
  focus?: string
}

export interface SearchRepoArgs {
  workspaceRoot: string
  query: string
  path?: string
  glob?: string
  maxResults?: number
}

export interface ReadSpanArgs {
  workspaceRoot: string
  items: Array<{
    path: string
    startLine?: number
    endLine?: number
  }>
}

export interface ResearchDossierArgs {
  workspaceRoot: string
  query: string
  glob?: string
  maxResults?: number
}

export interface VerifyChangeArgs {
  workspaceRoot: string
  checks?: ValidationCheck[]
  goal?: string
}

export interface CapabilityResponse {
  ok: boolean
  summary: string
  artifactId?: string
  structuredPayload?: unknown
  cacheStatus: 'hit' | 'miss'
}

interface TimedCacheEntry<T> {
  value: T
  expiresAt: number
}

interface TimedCacheStats {
  hitCount: number
  missCount: number
  expiredCount: number
  evictionCount: number
}

interface CapabilityCachePayload {
  ok: boolean
  summary: string
  structuredPayload?: unknown
}

interface RepoOverviewCacheEntry extends CapabilityResponse {
  capability: 'repo_overview'
  cacheKey: string
}

export interface CapabilityServices {
  repoOverview: (input: RepoOverviewInput) => Promise<RepoOverviewResult>
  searchRepo: (input: SearchRepoInput) => Promise<SearchRepoResult>
  readSpans: (input: ReadSpansInput) => Promise<{ summary: string; structuredPayload: unknown }>
  researchDossier?: (input: ResearchDossierInput) => Promise<ResearchDossierResult>
  verifyChange?: (input: VerifyChangeInput) => Promise<VerifyChangeResult>
}

export class CapabilityBroker {
  private readonly repoOverviewCache = new Map<string, RepoOverviewCacheEntry>()
  private readonly searchRepoCache = new Map<string, TimedCacheEntry<CapabilityCachePayload>>()
  private readonly readSpansCache = new Map<string, TimedCacheEntry<CapabilityCachePayload>>()
  private readonly searchRepoCacheStats: TimedCacheStats = { hitCount: 0, missCount: 0, expiredCount: 0, evictionCount: 0 }
  private readonly readSpansCacheStats: TimedCacheStats = { hitCount: 0, missCount: 0, expiredCount: 0, evictionCount: 0 }
  private capabilityCallSequence = 0
  private static readonly CAPABILITY_CACHE_TTL_MS = 120_000
  private static readonly SEARCH_REPO_CACHE_LIMIT = 32
  private static readonly READ_SPANS_CACHE_LIMIT = 24

  constructor(
    private readonly services: CapabilityServices,
    private readonly emit: (event: ChatStreamEvent) => void,
    private readonly emitLoopState?: (event: {
      requestId: string
      assistantMessageId?: string
      taskId: string
      event: LoopStateEventName
      phase: LoopPhase
      iteration: number
      summary: string
    }) => void
  ) {}

  async repoOverview(ctx: BrokerCallContext, args: RepoOverviewArgs): Promise<CapabilityResponse> {
    const cacheKey = this.repoOverviewCacheKey(args)
    const callId = this.nextCapabilityCallId(ctx, 'repo_overview')
    this.emitPhase(ctx, 'inspect', 'Gathering repository overview.')
    this.emitCapability(ctx, callId, 'repo_overview', 'capability_requested', {
      summary: args.focus ? `Preparing repo overview for ${args.focus}.` : 'Preparing repo overview.'
    })

    const cached = this.repoOverviewCache.get(cacheKey)
    if (cached) {
      this.emitCapability(ctx, callId, 'repo_overview', 'capability_cache_hit', {
        cached: true,
        summary: 'Using cached repo overview.'
      })
      this.emitCapability(ctx, callId, 'repo_overview', 'capability_completed', {
        cached: true,
        summary: cached.summary
      })
      return { ...cached, cacheStatus: 'hit' }
    }

    const startedAt = Date.now()
    this.emitCapability(ctx, callId, 'repo_overview', 'capability_started', {
      summary: 'Building repo overview.'
    })
    try {
      const result = await this.services.repoOverview(args)
      const response: RepoOverviewCacheEntry = {
        capability: 'repo_overview',
        cacheKey,
        ok: true,
        summary: result.summary,
        structuredPayload: result.structuredPayload,
        cacheStatus: 'miss'
      }
      this.repoOverviewCache.set(cacheKey, response)
      this.emitCapability(ctx, callId, 'repo_overview', 'capability_completed', {
        summary: result.summary,
        durationMs: Date.now() - startedAt
      })
      return response
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitCapability(ctx, callId, 'repo_overview', 'capability_failed', {
        summary: message,
        durationMs: Date.now() - startedAt
      })
      return {
        ok: false,
        summary: `repo_overview failed: ${message}`,
        cacheStatus: 'miss'
      }
    }
  }

  async searchRepo(ctx: BrokerCallContext, args: SearchRepoArgs): Promise<CapabilityResponse> {
    const cacheKey = this.searchRepoCacheKey(args)
    const startedAt = Date.now()
    const callId = this.nextCapabilityCallId(ctx, 'search_repo')
    this.emitPhase(ctx, 'inspect', `Searching repository for ${args.query}.`)
    const cacheMetrics = () => this.cacheMetrics(this.searchRepoCacheStats, this.searchRepoCache, CapabilityBroker.SEARCH_REPO_CACHE_LIMIT)
    this.emitCapability(ctx, callId, 'search_repo', 'capability_requested', {
      summary: `Searching repo for ${args.query}.`
    })

    const cached = this.getCache(this.searchRepoCache, cacheKey, this.searchRepoCacheStats)
    if (cached) {
      this.emitCapability(ctx, callId, 'search_repo', 'capability_cache_hit', {
        cached: true,
        summary: 'Using cached search_repo result.',
        ...cacheMetrics()
      })
      this.emitCapability(ctx, callId, 'search_repo', 'capability_completed', {
        cached: true,
        summary: cached.summary,
        ...cacheMetrics()
      })
      return { ...cached, cacheStatus: 'hit' }
    }

    this.emitCapability(ctx, callId, 'search_repo', 'capability_started', {
      summary: 'Running repo search.'
    })
    try {
      const result = await this.services.searchRepo(args)
      const response: CapabilityCachePayload = {
        ok: true,
        summary: result.summary,
        structuredPayload: result.structuredPayload
      }
      this.setCache(this.searchRepoCache, cacheKey, response, CapabilityBroker.SEARCH_REPO_CACHE_LIMIT, this.searchRepoCacheStats)
      this.emitCapability(ctx, callId, 'search_repo', 'capability_completed', {
        summary: result.summary,
        durationMs: Date.now() - startedAt,
        ...cacheMetrics()
      })
      return { ...response, cacheStatus: 'miss' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitCapability(ctx, callId, 'search_repo', 'capability_failed', {
        summary: message,
        durationMs: Date.now() - startedAt
      })
      return {
        ok: false,
        summary: `search_repo failed: ${message}`,
        cacheStatus: 'miss'
      }
    }
  }

  async readSpans(ctx: BrokerCallContext, args: ReadSpanArgs): Promise<CapabilityResponse> {
    const cacheKey = this.readSpansCacheKey(args)
    const startedAt = Date.now()
    const callId = this.nextCapabilityCallId(ctx, 'read_spans')
    this.emitPhase(ctx, 'inspect', `Reading ${args.items.length} repository span(s).`)
    const cacheMetrics = () => this.cacheMetrics(this.readSpansCacheStats, this.readSpansCache, CapabilityBroker.READ_SPANS_CACHE_LIMIT)
    this.emitCapability(ctx, callId, 'read_spans', 'capability_requested', {
      summary: `Reading ${args.items.length} repo span(s).`
    })

    const cached = this.getCache(this.readSpansCache, cacheKey, this.readSpansCacheStats)
    if (cached) {
      this.emitCapability(ctx, callId, 'read_spans', 'capability_cache_hit', {
        cached: true,
        summary: 'Using cached read_spans result.',
        ...cacheMetrics()
      })
      this.emitCapability(ctx, callId, 'read_spans', 'capability_completed', {
        cached: true,
        summary: cached.summary,
        ...cacheMetrics()
      })
      return { ...cached, cacheStatus: 'hit' }
    }

    this.emitCapability(ctx, callId, 'read_spans', 'capability_started', {
      summary: 'Reading bounded file spans.'
    })
    try {
      const result = await this.services.readSpans(args)
      const response: CapabilityCachePayload = {
        ok: true,
        summary: result.summary,
        structuredPayload: result.structuredPayload
      }
      this.setCache(this.readSpansCache, cacheKey, response, CapabilityBroker.READ_SPANS_CACHE_LIMIT, this.readSpansCacheStats)
      this.emitCapability(ctx, callId, 'read_spans', 'capability_completed', {
        summary: result.summary,
        durationMs: Date.now() - startedAt,
        ...cacheMetrics()
      })
      return { ...response, cacheStatus: 'miss' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitCapability(ctx, callId, 'read_spans', 'capability_failed', {
        summary: message,
        durationMs: Date.now() - startedAt
      })
      return {
        ok: false,
        summary: `read_spans failed: ${message}`,
        cacheStatus: 'miss'
      }
    }
  }

  async researchDossier(ctx: BrokerCallContext, args: ResearchDossierArgs): Promise<CapabilityResponse> {
    if (!this.services.researchDossier) {
      return {
        ok: false,
        summary: 'research_dossier is not configured.',
        cacheStatus: 'miss'
      }
    }
    const startedAt = Date.now()
    const callId = this.nextCapabilityCallId(ctx, 'research_dossier')
    this.emitPhase(ctx, 'recon', `Researching ${args.query}.`)
    this.emitCapability(ctx, callId, 'research_dossier', 'capability_requested', {
      summary: `Preparing research dossier for ${args.query}.`
    })
    this.emitCapability(ctx, callId, 'research_dossier', 'capability_started', {
      summary: 'Gathering repo evidence and synthesizing dossier.'
    })
    try {
      const result = await this.services.researchDossier(args)
      this.emitCapability(ctx, callId, 'research_dossier', 'capability_completed', {
        summary: result.summary,
        durationMs: Date.now() - startedAt
      })
      return {
        ok: true,
        summary: result.summary,
        structuredPayload: result.structuredPayload,
        cacheStatus: 'miss'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitCapability(ctx, callId, 'research_dossier', 'capability_failed', {
        summary: message,
        durationMs: Date.now() - startedAt
      })
      return {
        ok: false,
        summary: `research_dossier failed: ${message}`,
        cacheStatus: 'miss'
      }
    }
  }

  async verifyChange(ctx: BrokerCallContext, args: VerifyChangeArgs): Promise<CapabilityResponse> {
    if (!this.services.verifyChange) {
      return {
        ok: false,
        summary: 'verify_change is not configured.',
        cacheStatus: 'miss'
      }
    }
    const startedAt = Date.now()
    const callId = this.nextCapabilityCallId(ctx, 'verify_change')
    this.emitPhase(ctx, 'validate', 'Running change verification.')
    this.emitCapability(ctx, callId, 'verify_change', 'capability_requested', {
      summary: args.checks?.length
        ? `Preparing verification for ${args.checks.join(', ')}.`
        : 'Preparing verification plan.'
    })
    this.emitCapability(ctx, callId, 'verify_change', 'capability_started', {
      summary: 'Running verification checks.'
    })
    this.emitVerification(ctx, {
      event: 'verification_started',
      summary: args.checks?.length
        ? `Starting checks: ${args.checks.join(', ')}`
        : 'Starting verification.'
    })
    try {
      const result = await this.services.verifyChange(args)
      for (const check of result.structuredPayload.checks) {
        this.emitVerification(ctx, {
          event: 'verification_check_started',
          check: check.check,
          summary: `Running ${check.check}.`
        })
        this.emitVerification(ctx, {
          event: 'verification_check_finished',
          check: check.check,
          status: check.ok ? 'pass' : 'fail',
          summary: check.output
        })
      }
      this.emitCapability(ctx, callId, 'verify_change', result.ok ? 'capability_completed' : 'capability_failed', {
        summary: result.summary,
        durationMs: Date.now() - startedAt
      })
      this.emitVerification(ctx, {
        event:
          result.status === 'pass'
            ? 'verification_passed'
            : result.status === 'blocked'
              ? 'verification_blocked'
              : 'verification_failed',
        status: result.status,
        summary: result.summary
      })
      return {
        ok: result.ok,
        summary: result.summary,
        structuredPayload: result.structuredPayload,
        cacheStatus: 'miss'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitCapability(ctx, callId, 'verify_change', 'capability_failed', {
        summary: message,
        durationMs: Date.now() - startedAt
      })
      this.emitVerification(ctx, {
        event: 'verification_blocked',
        status: 'blocked',
        summary: message
      })
      return {
        ok: false,
        summary: `verify_change failed: ${message}`,
        cacheStatus: 'miss'
      }
    }
  }

  private repoOverviewCacheKey(args: RepoOverviewArgs): string {
    return JSON.stringify({
      workspaceRoot: args.workspaceRoot,
      focus: args.focus?.trim().toLowerCase() || ''
    })
  }

  private searchRepoCacheKey(args: SearchRepoArgs): string {
    return JSON.stringify({
      workspaceRoot: args.workspaceRoot,
      query: args.query,
      path: args.path?.trim() || null,
      glob: args.glob ?? null,
      maxResults: args.maxResults ?? null
    })
  }

  private readSpansCacheKey(args: ReadSpanArgs): string {
    const items = args.items
      .map((item) => ({ path: item.path, startLine: item.startLine ?? null, endLine: item.endLine ?? null }))
      .sort((a, b) => {
        if (a.path === b.path) {
          return (a.startLine ?? 0) - (b.startLine ?? 0) || (a.endLine ?? 0) - (b.endLine ?? 0)
        }
        return a.path.localeCompare(b.path)
      })
    return JSON.stringify({ workspaceRoot: args.workspaceRoot, items })
  }

  private getCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, stats: TimedCacheStats): T | null {
    const entry = cache.get(key)
    if (!entry) {
      stats.missCount += 1
      return null
    }
    if (entry.expiresAt < Date.now()) {
      cache.delete(key)
      stats.missCount += 1
      stats.expiredCount += 1
      return null
    }
    stats.hitCount += 1
    return entry.value
  }

  private setCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T, limit: number, stats: TimedCacheStats): void {
    if (cache.has(key)) cache.delete(key)
    if (cache.size >= limit) {
      const first = cache.keys().next().value
      if (first !== undefined) {
        cache.delete(first)
        stats.evictionCount += 1
      }
    }
    cache.set(key, { value, expiresAt: Date.now() + CapabilityBroker.CAPABILITY_CACHE_TTL_MS })
  }

  private cacheMetrics(
    stats: TimedCacheStats,
    cache: Map<string, unknown>,
    limit: number
  ): {
    cacheHitCount: number
    cacheMissCount: number
    cacheSize: number
    cacheLimit: number
    cacheTtlMs: number
    cacheExpired: number
    cacheEvictions: number
  } {
    return {
      cacheHitCount: stats.hitCount,
      cacheMissCount: stats.missCount,
      cacheSize: cache.size,
      cacheLimit: limit,
      cacheTtlMs: CapabilityBroker.CAPABILITY_CACHE_TTL_MS,
      cacheExpired: stats.expiredCount,
      cacheEvictions: stats.evictionCount
    }
  }

  private emitCapability(
    ctx: BrokerCallContext,
    callId: string,
    capability: CapabilityName,
    event: CapabilityActivityEventName,
    extra: Omit<
      Extract<ChatStreamEvent, { type: 'capability_activity' }>,
      'requestId' | 'assistantMessageId' | 'type' | 'callId' | 'capability' | 'event'
    > = {}
  ): void {
    this.emit({
      requestId: ctx.requestId,
      ...(ctx.assistantMessageId ? { assistantMessageId: ctx.assistantMessageId } : {}),
      type: 'capability_activity',
      callId,
      capability,
      event,
      ...extra
    })
  }

  private nextCapabilityCallId(ctx: BrokerCallContext, capability: CapabilityName): string {
    this.capabilityCallSequence += 1
    return `${capability}:${ctx.taskId}:${this.capabilityCallSequence}`
  }

  private emitVerification(
    ctx: BrokerCallContext,
    extra: Omit<
      Extract<ChatStreamEvent, { type: 'verification_state' }>,
      'requestId' | 'assistantMessageId' | 'type'
    >
  ): void {
    this.emit({
      requestId: ctx.requestId,
      ...(ctx.assistantMessageId ? { assistantMessageId: ctx.assistantMessageId } : {}),
      type: 'verification_state',
      ...extra
    })
  }

  private emitPhase(
    ctx: BrokerCallContext,
    phase: LoopPhase,
    summary: string
  ): void {
    this.emitLoopState?.({
      requestId: ctx.requestId,
      assistantMessageId: ctx.assistantMessageId,
      taskId: ctx.taskId,
      event: 'phase_changed',
      phase,
      iteration: ctx.iteration ?? 1,
      summary
    })
  }
}
