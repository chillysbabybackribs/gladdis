import type { ToolDef } from '../browserTools'

/**
 * SEARCH — web search & page fetch surface. `search` is the SERP+evidence
 * compaction; `deep_search` is the multi-page recursive crawl with
 * Gemini-driven synthesis; `fetch_page` is the explicit single-URL fetch.
 */
export const SEARCH_TOOLS: ToolDef[] = [
  {
    name: 'search',
    description:
      'Find web pages and evidence. Keeps the visible tab unchanged by default. ' +
      'Set `navigate_visible: true` (or omit it when the user explicitly asks to "open/visit/navigate to the result/page/site") to also load the best hit in the visible tab.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'SERP hits to return (1-8). Default 4.' },
        digest_top: { type: 'number', description: 'Live-evidence hits to probe (0-3). Default 2.' },
        focus: { type: 'string', description: 'Optional keyword to weight excerpt selection.' },
        navigate_visible: {
          type: 'boolean',
          description:
            'If true, navigates the active visible browser tab to the best search result. ' +
            'If omitted, Gladdis auto-navigates only when the user explicitly asked to open/visit/navigate to a result; otherwise it stays background-only.'
        }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        navigateVisible: { type: 'boolean' },
        limit: { type: 'number' },
        digestTop: { type: 'number' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              snippet: { type: 'string' },
              instantAnswer: { type: 'string' },
              originQuery: { type: 'string' },
              relevanceScore: { type: 'number' }
            },
            required: ['title', 'url', 'originQuery', 'relevanceScore']
          }
        },
        digests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              relevanceScore: { type: 'number' },
              digest: { type: 'string' },
              wallDetected: { type: 'string' }
            },
            required: ['url', 'title', 'relevanceScore', 'digest']
          }
        }
      },
      required: ['query', 'navigateVisible', 'limit', 'digestTop', 'results', 'digests']
    }
  },
  {
    name: 'search_open',
    description:
      'Run a web search and open a likely direct URL in parallel. Use when you know a site or page worth checking directly but still want search fallback/evidence in the same step.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        url: { type: 'string', description: 'Full URL to open in the visible tab while search runs in parallel.' },
        limit: { type: 'number', description: 'SERP hits to return (1-8). Default 4.' },
        digest_top: { type: 'number', description: 'Live-evidence hits to probe (0-3). Default 2.' },
        focus: { type: 'string', description: 'Optional keyword to weight excerpt selection.' },
        viewportOnly: {
          type: 'boolean',
          description: 'If true, only include visible-on-screen actions in the direct-page digest.'
        }
      },
      required: ['query', 'url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        url: { type: 'string' },
        search: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            navigateVisible: { type: 'boolean' },
            limit: { type: 'number' },
            digestTop: { type: 'number' },
            results: { type: 'array', items: { type: 'object' } },
            digests: { type: 'array', items: { type: 'object' } }
          },
          required: ['query', 'navigateVisible', 'limit', 'digestTop', 'results', 'digests']
        },
        page: {
          type: 'object',
          properties: {
            requestedUrl: { type: 'string' },
            finalUrl: { type: 'string' },
            pageUrl: { type: 'string' },
            focus: { type: 'string' },
            viewportOnly: { type: 'boolean' },
            digest: { type: 'string' },
            timings: {
              type: 'object',
              properties: {
                preflightMs: { type: 'number' },
                navigateCaptureMs: { type: 'number' },
                readableMs: { type: 'number' },
                extractMs: { type: 'number' },
                digestMs: { type: 'number' },
                totalMs: { type: 'number' }
              },
              required: ['preflightMs', 'navigateCaptureMs', 'readableMs', 'extractMs', 'digestMs', 'totalMs']
            }
          },
          required: ['requestedUrl', 'finalUrl', 'pageUrl', 'viewportOnly', 'digest', 'timings']
        }
      },
      required: ['query', 'url', 'search', 'page']
    }
  },
  {
    name: 'fetch_page',
    description:
      'Open a URL in the visible tab and return a bounded digest after navigation settles.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open in the visible tab.' },
        focus: {
          type: 'string',
          description: 'Optional keyword to rank relevant actions and links in the digest.'
        },
        viewportOnly: {
          type: 'boolean',
          description: 'If true, only include visible-on-screen actions in the digest.'
        }
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        requestedUrl: { type: 'string' },
        finalUrl: { type: 'string' },
        pageUrl: { type: 'string' },
        focus: { type: 'string' },
        viewportOnly: { type: 'boolean' },
        digest: { type: 'string' },
        timings: {
          type: 'object',
          properties: {
            preflightMs: { type: 'number' },
            navigateCaptureMs: { type: 'number' },
            readableMs: { type: 'number' },
            extractMs: { type: 'number' },
            digestMs: { type: 'number' },
            totalMs: { type: 'number' }
          },
          required: ['preflightMs', 'navigateCaptureMs', 'readableMs', 'extractMs', 'digestMs', 'totalMs']
        }
      },
      required: ['requestedUrl', 'finalUrl', 'pageUrl', 'viewportOnly', 'digest', 'timings']
    }
  },
  {
    name: 'deep_search',
    description:
      'Research topic with recursive web crawl + synthesis. For routine lookups, use search + fetch_page.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The main research topic or question.' },
        depth: {
          type: 'number',
          description: 'Recursion depth: 1 direct-only, 2 includes links. Default 2.'
        },
        max_pages: {
          type: 'number',
          description: 'Maximum pages to crawl. Default 5.'
        }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        depth: { type: 'number' },
        maxPages: { type: 'number' },
        queriesRun: { type: 'array', items: { type: 'string' } },
        sourcesVisited: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              depth: { type: 'number' }
            },
            required: ['url', 'title', 'depth']
          }
        }
      },
      required: ['query', 'depth', 'maxPages', 'queriesRun', 'sourcesVisited']
    }
  }
]
