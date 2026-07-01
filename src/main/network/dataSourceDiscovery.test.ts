import { describe, expect, it } from 'vitest'

import { formatDataSourceDiscovery, summarizeDataSourceDiscovery } from './dataSourceDiscovery'

describe('summarizeDataSourceDiscovery', () => {
  it('classifies JSON fetches as api_backed and surfaces sample keys', () => {
    const summary = summarizeDataSourceDiscovery(
      {
        totalSeen: 1,
        captured: [
          {
            requestId: 'req-1',
            url: 'https://example.com/api/comments',
            method: 'GET',
            status: 200,
            mimeType: 'application/json',
            type: 'Fetch',
            success: true,
            durationMs: 90,
            encodedDataLength: 321
          }
        ],
        bodies: [
          {
            requestId: 'req-1',
            url: 'https://example.com/api/comments',
            status: 200,
            mimeType: 'application/json',
            body: '{"comments":[{"id":1,"author":"ada"}]}',
            truncated: false
          }
        ]
      },
      { pageUrl: 'https://example.com/story/1', maxCandidates: 3 }
    )

    expect(summary.pageMode).toBe('api_backed')
    expect(summary.candidateApis[0]).toMatchObject({
      url: 'https://example.com/api/comments',
      kind: 'json'
    })
    expect(summary.candidateApis[0]?.sampleKeys).toEqual(['comments'])
  })

  it('classifies document-only traffic as server_rendered', () => {
    const summary = summarizeDataSourceDiscovery(
      {
        totalSeen: 1,
        captured: [
          {
            requestId: 'doc-1',
            url: 'https://example.com/story/1',
            method: 'GET',
            status: 200,
            mimeType: 'text/html',
            type: 'Document',
            success: true
          }
        ],
        bodies: []
      },
      { pageUrl: 'https://example.com/story/1' }
    )

    expect(summary.pageMode).toBe('server_rendered')
    expect(summary.candidateApis).toHaveLength(0)
  })

  it('flags likely bot-protection traffic', () => {
    const summary = summarizeDataSourceDiscovery(
      {
        totalSeen: 1,
        captured: [
          {
            requestId: 'req-1',
            url: 'https://example.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1',
            method: 'GET',
            status: 403,
            mimeType: 'text/html',
            type: 'Document',
            success: false
          }
        ],
        bodies: [
          {
            requestId: 'req-1',
            url: 'https://example.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1',
            status: 403,
            mimeType: 'text/html',
            body: '<html><title>Attention Required</title>Verify you are human</html>',
            truncated: false
          }
        ]
      },
      { pageUrl: 'https://example.com/' }
    )

    expect(summary.botProtectionSuspected).toBe(true)
    expect(formatDataSourceDiscovery(summary)).toContain('Bot protection signals')
  })
})
