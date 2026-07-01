import { describe, expect, it } from 'vitest'
import { buildTraceDebugPayload, deriveExecutionSummary, deriveValidationState } from './ChatMessageBody'
import type { ToolActivity } from './chatTypes'

function tool(
  toolName: string,
  status: ToolActivity['status'] = 'ok',
  callId = `${toolName}_${status}`
): ToolActivity {
  return {
    callId,
    tool: toolName,
    args: {},
    status
  }
}

describe('deriveValidationState', () => {
  it('does not require validation when no files were edited', () => {
    expect(deriveValidationState([tool('read_file')])).toBe('no-edits')
  })

  it('marks edits as pending until validation runs', () => {
    expect(deriveValidationState([tool('edit_file')])).toBe('pending')
  })

  it('shows repair required after validation fails', () => {
    expect(deriveValidationState([tool('edit_file'), tool('run_validation', 'error')])).toBe(
      'repair-required'
    )
  })

  it('keeps repair required after a failed validation until the repaired edit is validated', () => {
    expect(
      deriveValidationState([
        tool('edit_file'),
        tool('run_validation', 'error'),
        tool('edit_file', 'ok', 'fix_edit')
      ])
    ).toBe('repair-required')
  })

  it('distinguishes validation passing after a repair', () => {
    expect(
      deriveValidationState([
        tool('edit_file'),
        tool('run_validation', 'error'),
        tool('edit_file', 'ok', 'fix_edit'),
        tool('run_validation', 'ok', 'repair_validation')
      ])
    ).toBe('validated-after-repair')
  })

  it('preserves the auto-validation label for clean auto fallback passes', () => {
    expect(
      deriveValidationState([
        tool('edit_file'),
        tool('run_validation', 'ok', 'auto_validation_typecheck_1')
      ])
    ).toBe('auto-validated')
  })
})

describe('buildTraceDebugPayload', () => {
  it('copies sanitized routing evidence without prompt text', () => {
    const payload = buildTraceDebugPayload(
      {
        profile: 'codex',
        tools: ['read_file', 'edit_file'],
        activePage: { included: true, reason: 'active-page-reference' },
        workspace: {
          included: true,
          reason: 'local-path',
          detail: '/tmp/project'
        },
        codexCwd: {
          included: true,
          reason: 'selected-folder',
          detail: '/tmp/project'
        },
        inputs: {
          selectedFolder: '/tmp/project',
          activePageContext: 'Docs - https://docs.example/',
          codexCwd: '/tmp/project'
        }
      },
      'validated',
      [
        {
          callId: 'call-1',
          tool: 'navigate',
          args: { url: 'https://docs.example/' },
          status: 'ok',
          startedAt: 1000,
          endedAt: 3250,
          durationMs: 2250,
          preview: 'Docs page'
        }
      ]
    )

    expect(payload).toEqual({
      profile: 'codex',
      validation: 'validated',
      inputs: {
        selectedFolder: '/tmp/project',
        activePageContext: 'Docs - https://docs.example/',
        codexCwd: '/tmp/project'
      },
      decisions: {
        activePage: { included: true, reason: 'active-page-reference' },
        workspace: { included: true, reason: 'local-path', detail: '/tmp/project' },
        codexCwd: { included: true, reason: 'selected-folder', detail: '/tmp/project' }
      },
      tools: ['read_file', 'edit_file'],
      execution: {
        toolCalls: 1,
        totalDurationMs: 2250,
        totalDurationLabel: '2.3s',
        slowestTool: 'navigate',
        slowestDurationMs: 2250,
        slowestLabel: 'navigate 2.3s',
        searchCalls: 0,
        fetchCalls: 1,
        duplicateSearches: 0,
        duplicateFetches: 0,
        duplicateFinalFetches: 0,
        cacheReuses: 0,
        duplicateLabel: 'none',
        brief: '1 call'
      },
      executedTools: [
        {
          callId: 'call-1',
          tool: 'navigate',
          args: { url: 'https://docs.example/' },
          status: 'ok',
          startedAt: 1000,
          endedAt: 3250,
          durationMs: 2250,
          preview: 'Docs page'
        }
      ]
    })
    expect(JSON.stringify(payload)).not.toContain('summarize this page')
  })
})

describe('deriveExecutionSummary', () => {
  it('counts different fetch requests that land on the same final page', () => {
    const summary = deriveExecutionSummary([
      {
        callId: 'fetch-1',
        tool: 'navigate',
        args: { url: 'https://platform.openai.com/docs/api-reference/responses-streaming' },
        status: 'ok',
        durationMs: 25_000,
        preview: 'URL: https://developers.openai.com/api/docs/guides/streaming-responses TITLE: Streaming'
      },
      {
        callId: 'fetch-2',
        tool: 'navigate',
        args: { url: 'https://developers.openai.com/api/docs/guides/streaming-responses' },
        status: 'ok',
        durationMs: 468,
        preview: 'URL: https://developers.openai.com/api/docs/guides/streaming-responses TITLE: Streaming'
      }
    ])

    expect(summary.duplicateFetches).toBe(0)
    expect(summary.duplicateFinalFetches).toBe(1)
    expect(summary.duplicateLabel).toContain('1 same final page')
    expect(summary.brief).toContain('slowest navigate 25s')
  })
})
