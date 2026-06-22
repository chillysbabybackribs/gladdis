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
      'This is your DEFAULT, primary tool for finding web pages, looking up documentation, and answering factual queries. ' +
      'Web search via embedded Chromium (DuckDuckGo). Searches your query exactly as given — ' +
      'it does NOT invent query variants, so phrase the query well. ' +
      'Returns a SERP index (with instant answers) plus live evidence extracted from the top ' +
      'results probed in background tabs. ' +
      'This tool does NOT automatically navigate or change the active visible tab unless navigate_visible: true is explicitly passed, ' +
      'allowing you to search safely without disrupting the user\'s view or your own page state. ' +
      'Use fetch_page on a URL from the search results when you want to open and read a specific page in the visible tab.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Max SERP hits to return (1–8). Default 4.' },
        digest_top: { type: 'number', description: 'Top hits to probe for live evidence (0–3). Default 2.' },
        focus: { type: 'string', description: 'Optional keyword to weight excerpt selection.' },
        navigate_visible: {
          type: 'boolean',
          description:
            'If true, navigates the active visible browser tab to the best search result. ' +
            'Default is false (the search is run cleanly in background tabs without changing the user\'s current page).'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_page',
    description:
      'Open a specific URL in the visible browser tab, wait for navigation to settle, and return a bounded page digest. ' +
      'Use when you already have a target URL (from search results or the user) and need to navigate to it and read its content.',
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
      'Use ONLY for highly complex, multi-faceted research tasks, comprehensive comparisons, or troubleshooting topics ' +
      'that require extensive multi-page scraping and recursive link harvesting. DO NOT use for standard queries, ' +
      'simple lookups, or finding a single documentation page where search + fetch_page is faster, cleaner, and more precise. ' +
      'First formulates a strategic research plan (using Gemini 2.5 Flash-lite), then executes a fully deterministic parallel ' +
      'crawl across search results and harvested links using native background Chromium tabs. ' +
      'It reads, extracts, and score-ranks information on multiple pages recursively without requiring any intermediate LLM calls, ' +
      'reducing token consumption by 90%+. Returns a beautifully compiled, highly detailed knowledge dossier.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The main research topic or question.' },
        depth: {
          type: 'number',
          description:
            'Recursion depth (1: only direct search hits, 2: search hits + harvesting links on those hits). Default 2.'
        },
        max_pages: {
          type: 'number',
          description: 'Maximum total pages to crawl and read across all steps. Default 5.'
        }
      },
      required: ['query']
    }
  }
]
