import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../../../../shared/types'
import { CapabilityBroker } from './CapabilityBroker'
import type { RepoOverviewInput } from './RepoIntelligenceService'

describe('CapabilityBroker', () => {
  it('emits request, start, complete, then cache-hit events for repo_overview', async () => {
    const emitted: ChatStreamEvent[] = []
    const broker = new CapabilityBroker(
      {
        repoOverview: async ({ workspaceRoot, focus }: RepoOverviewInput) => ({
          summary: `Workspace: ${workspaceRoot}\nFocus: ${focus}`,
          structuredPayload: { workspaceRoot, focus }
        })
      } as any,
      (event) => emitted.push(event)
    )
    const ctx = { requestId: 'req-1', assistantMessageId: 'msg-1', taskId: 'task-1' }
    const args = { workspaceRoot: '/tmp/demo', focus: 'chat' }

    const first = await broker.repoOverview(ctx, args)
    const second = await broker.repoOverview(ctx, args)

    expect(first.ok).toBe(true)
    expect(first.cacheStatus).toBe('miss')
    expect(second.ok).toBe(true)
    expect(second.cacheStatus).toBe('hit')
    expect(
      emitted
        .filter((event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity')
        .map((event) => event.event)
    ).toEqual([
      'capability_requested',
      'capability_started',
      'capability_completed',
      'capability_requested',
      'capability_cache_hit',
      'capability_completed'
    ])
    const activityEvents = emitted.filter(
      (event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity'
    )
    expect(activityEvents.slice(0, 3).map((event) => event.callId)).toEqual([
      'repo_overview:task-1:1',
      'repo_overview:task-1:1',
      'repo_overview:task-1:1'
    ])
    expect(activityEvents.slice(3).map((event) => event.callId)).toEqual([
      'repo_overview:task-1:2',
      'repo_overview:task-1:2',
      'repo_overview:task-1:2'
    ])
  })

  it('emits the search_repo lifecycle without caching', async () => {
    const emitted: ChatStreamEvent[] = []
    const broker = new CapabilityBroker(
      {
        repoOverview: async () => ({
          summary: 'unused',
          structuredPayload: {}
        }),
        searchRepo: async () => ({
          summary: 'Search query: chat\nHits:\nsrc/main/foo.ts:12 - chat',
          structuredPayload: { totalHits: 1 }
        })
      } as any,
      (event) => emitted.push(event)
    )

    const result = await broker.searchRepo(
      { requestId: 'req-2', assistantMessageId: 'msg-2', taskId: 'task-2' },
      { workspaceRoot: '/tmp/demo', query: 'chat' }
    )

    expect(result.ok).toBe(true)
    expect(result.cacheStatus).toBe('miss')
    expect(
      emitted
        .filter((event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity')
        .map((event) => `${event.capability}:${event.event}`)
    ).toEqual([
      'search_repo:capability_requested',
      'search_repo:capability_started',
      'search_repo:capability_completed'
    ])
    expect(
      emitted
        .filter((event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity')
        .map((event) => event.callId)
    ).toEqual(['search_repo:task-2:1', 'search_repo:task-2:1', 'search_repo:task-2:1'])
  })

  it('treats scoped search_repo calls as distinct cache entries', async () => {
    const emitted: ChatStreamEvent[] = []
    const searchRepo = async ({ path }: { path?: string }) => ({
      summary: `Search path: ${path ?? '.'}`,
      structuredPayload: { totalHits: 1, path: path ?? '.' }
    })
    const broker = new CapabilityBroker(
      {
        repoOverview: async () => ({
          summary: 'unused',
          structuredPayload: {}
        }),
        searchRepo
      } as any,
      (event) => emitted.push(event)
    )

    const ctx = { requestId: 'req-2b', assistantMessageId: 'msg-2b', taskId: 'task-2b' }
    const baseArgs = { workspaceRoot: '/tmp/demo', query: 'chat', glob: '*.ts', maxResults: 5 }

    const first = await broker.searchRepo(ctx, { ...baseArgs, path: 'src/main' })
    const second = await broker.searchRepo(ctx, { ...baseArgs, path: 'src/main' })
    const third = await broker.searchRepo(ctx, { ...baseArgs, path: 'src/renderer' })

    expect(first.cacheStatus).toBe('miss')
    expect(second.cacheStatus).toBe('hit')
    expect(third.cacheStatus).toBe('miss')
    expect(
      emitted
        .filter((event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity' && event.event === 'capability_cache_hit')
        .map((event) => event.callId)
    ).toEqual(['search_repo:task-2b:2'])
  })

  it('emits the read_spans lifecycle without caching', async () => {
    const emitted: ChatStreamEvent[] = []
    const broker = new CapabilityBroker(
      {
        repoOverview: async () => ({
          summary: 'unused',
          structuredPayload: {}
        }),
        searchRepo: async () => ({
          summary: 'unused',
          structuredPayload: {}
        }),
        readSpans: async () => ({
          summary: '=== src/example.ts (lines 2-3 of 5) ===\nline 2\nline 3',
          structuredPayload: { items: 1 }
        })
      } as any,
      (event) => emitted.push(event)
    )

    const result = await broker.readSpans(
      { requestId: 'req-3', assistantMessageId: 'msg-3', taskId: 'task-3' },
      { workspaceRoot: '/tmp/demo', items: [{ path: 'src/example.ts', startLine: 2, endLine: 3 }] }
    )

    expect(result.ok).toBe(true)
    expect(result.cacheStatus).toBe('miss')
    expect(
      emitted
        .filter((event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity')
        .map((event) => `${event.capability}:${event.event}`)
    ).toEqual([
      'read_spans:capability_requested',
      'read_spans:capability_started',
      'read_spans:capability_completed'
    ])
  })

  it('emits the research_dossier lifecycle without caching', async () => {
    const emitted: ChatStreamEvent[] = []
    const broker = new CapabilityBroker(
      {
        repoOverview: async () => ({
          summary: 'unused',
          structuredPayload: {
            workspaceRoot: '/tmp/demo',
            packageManager: null,
            packageName: null,
            scripts: [],
            keyFiles: [],
            topDirectories: [],
            entryPoints: []
          }
        }),
        searchRepo: async () => ({ summary: 'unused', structuredPayload: { workspaceRoot: '/tmp/demo', query: 'unused', totalHits: 0, hits: [], suggestedSpans: [], context: { chars: 0, estimatedTokens: 0, hitCount: 0, suggestedSpanCount: 0 } } }),
        readSpans: async () => ({ summary: 'unused', structuredPayload: {} }),
        researchDossier: async () => ({
          summary: '## Dossier\nRelevant files: src/main/models/ChatService.ts',
          structuredPayload: {
            workspaceRoot: '/tmp/demo',
            query: 'chat service architecture',
            searchedFiles: ['src/main/models/ChatService.ts'],
            suggestedSpans: [],
            context: {
              promptChars: 0,
              estimatedPromptTokens: 0,
              searchSummaryChars: 0,
              readSpanChars: 0,
              estimatedReadSpanTokens: 0,
              suggestedSpanCount: 0,
              selectedFileBytes: 0,
              estimatedFullFileTokens: 0,
              estimatedTokensSavedBySpans: 0
            }
          }
        })
      },
      (event) => emitted.push(event)
    )

    const result = await broker.researchDossier(
      { requestId: 'req-4', assistantMessageId: 'msg-4', taskId: 'task-4' },
      { workspaceRoot: '/tmp/demo', query: 'chat service architecture' }
    )

    expect(result.ok).toBe(true)
    expect(result.cacheStatus).toBe('miss')
    expect(
      emitted
        .filter((event): event is Extract<ChatStreamEvent, { type: 'capability_activity' }> => event.type === 'capability_activity')
        .map((event) => `${event.capability}:${event.event}`)
    ).toEqual([
      'research_dossier:capability_requested',
      'research_dossier:capability_started',
      'research_dossier:capability_completed'
    ])
  })

  it('emits capability and verification events for verify_change', async () => {
    const emitted: ChatStreamEvent[] = []
    const broker = new CapabilityBroker(
      {
        repoOverview: async () => ({
          summary: 'unused',
          structuredPayload: {
            workspaceRoot: '/tmp/demo',
            packageManager: null,
            packageName: null,
            scripts: [],
            keyFiles: [],
            topDirectories: [],
            entryPoints: []
          }
        }),
        searchRepo: async () => ({ summary: 'unused', structuredPayload: { workspaceRoot: '/tmp/demo', query: 'unused', totalHits: 0, hits: [], suggestedSpans: [], context: { chars: 0, estimatedTokens: 0, hitCount: 0, suggestedSpanCount: 0 } } }),
        readSpans: async () => ({ summary: 'unused', structuredPayload: {} }),
        verifyChange: async () => ({
          ok: true,
          status: 'pass',
          summary: 'typecheck: pass\n(no output)',
          language: 'node',
          structuredPayload: {
            workspaceRoot: '/tmp/demo',
            language: 'node',
            checks: [{ check: 'typecheck', ok: true, output: '(no output)' }]
          }
        })
      },
      (event) => emitted.push(event)
    )

    const result = await broker.verifyChange(
      { requestId: 'req-5', assistantMessageId: 'msg-5', taskId: 'task-5' },
      { workspaceRoot: '/tmp/demo', checks: ['typecheck'] }
    )

    expect(result.ok).toBe(true)
    expect(
      emitted.filter((event) => event.type === 'capability_activity').map((event: any) => `${event.capability}:${event.event}`)
    ).toEqual([
      'verify_change:capability_requested',
      'verify_change:capability_started',
      'verify_change:capability_completed'
    ])
    expect(
      emitted.filter((event) => event.type === 'verification_state').map((event: any) => event.event)
    ).toEqual([
      'verification_started',
      'verification_check_started',
      'verification_check_finished',
      'verification_passed'
    ])
  })

  it('emits loop phase changes for broker capabilities with event and iteration context', async () => {
    const loopStates: Array<{ event: string; phase: string; iteration: number; summary: string }> = []
    const broker = new CapabilityBroker(
      {
        repoOverview: async () => ({
          summary: 'Workspace: /tmp/demo',
          structuredPayload: {
            workspaceRoot: '/tmp/demo',
            packageManager: null,
            packageName: null,
            scripts: [],
            keyFiles: [],
            topDirectories: [],
            entryPoints: []
          }
        }),
        searchRepo: async () => ({ summary: 'unused', structuredPayload: { workspaceRoot: '/tmp/demo', query: 'unused', totalHits: 0, hits: [], suggestedSpans: [], context: { chars: 0, estimatedTokens: 0, hitCount: 0, suggestedSpanCount: 0 } } }),
        readSpans: async () => ({ summary: 'unused', structuredPayload: {} }),
        researchDossier: async () => ({
          summary: '## Dossier',
          structuredPayload: { workspaceRoot: '/tmp/demo', query: 'chat', searchedFiles: [], suggestedSpans: [], context: { promptChars: 0, estimatedPromptTokens: 0, searchSummaryChars: 0, readSpanChars: 0, estimatedReadSpanTokens: 0, suggestedSpanCount: 0, selectedFileBytes: 0, estimatedFullFileTokens: 0, estimatedTokensSavedBySpans: 0 } }
        }),
        verifyChange: async () => ({
          ok: true,
          status: 'pass',
          summary: 'typecheck: pass',
          language: 'node',
          structuredPayload: { workspaceRoot: '/tmp/demo', language: 'node', checks: [] }
        })
      },
      () => {},
      (event) =>
        loopStates.push({
          event: event.event,
          phase: event.phase,
          iteration: event.iteration,
          summary: event.summary
        })
    )

    await broker.repoOverview({ requestId: 'req', taskId: 'task', iteration: 2 }, { workspaceRoot: '/tmp/demo' })
    await broker.researchDossier(
      { requestId: 'req', taskId: 'task', iteration: 3 },
      { workspaceRoot: '/tmp/demo', query: 'chat' }
    )
    await broker.verifyChange(
      { requestId: 'req', taskId: 'task', iteration: 4 },
      { workspaceRoot: '/tmp/demo', checks: ['typecheck'] }
    )

    expect(loopStates).toEqual([
      { event: 'phase_changed', phase: 'inspect', iteration: 2, summary: 'Gathering repository overview.' },
      { event: 'phase_changed', phase: 'recon', iteration: 3, summary: 'Researching chat.' },
      { event: 'phase_changed', phase: 'validate', iteration: 4, summary: 'Running change verification.' }
    ])
  })
})
