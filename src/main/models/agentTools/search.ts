import type { ToolDef } from '../browserTools'

/**
 * SEARCH — web search surface. `search` is the SERP+evidence compaction; with
 * `navigate_visible: true` it also loads the best hit in the visible tab. To
 * read a known URL, navigate to it then grep_page — no separate fetch verb.
 *
 * There is no `search_tool` (tool-discovery) verb: every turn now receives the
 * full flat tool surface (Phase C), so there is nothing to discover. The old
 * discovery hatch only existed to reach tools a per-turn router had pruned, and
 * OpenAI-family models could not call a tool that was never advertised anyway.
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
  }
]
