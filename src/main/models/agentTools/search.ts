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
      'Find web pages and evidence. For browser-oriented tasks it also opens the best result in the visible tab; otherwise it keeps the visible tab unchanged unless `navigate_visible` is true.',
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
            'If omitted, Gladdis auto-navigates for browser-oriented tasks and stays background-only for pure research.'
        }
      },
      required: ['query']
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
    }
  }
]
