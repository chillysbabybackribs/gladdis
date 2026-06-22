import type { ToolDef } from '../browserTools'

/**
 * SEARCH — web search & page fetch surface. `search` is the SERP+evidence
 * compaction; `deep_search` is the multi-page recursive crawl with
 * Gemini-driven synthesis; `fetch_page` is the explicit single-URL fetch.
 */
export const SEARCH_TOOLS: ToolDef[] = [
  {
    name: 'deep_search',
    description:
      'Performs a deep, multi-step web search and crawl. First formulates a strategic research plan (using Gemini 2.5 Flash-lite), ' +
      'then executes a fully deterministic parallel crawl across search results and harvested links using native background Chromium tabs. ' +
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
  },
  {
    name: 'search',
    description:
      'Web search via embedded Chromium (DuckDuckGo). Searches your query exactly as given — ' +
      'it does NOT invent query variants, so phrase the query well, and if you want alternate ' +
      'phrasings issue multiple search calls. ' +
      'Returns a SERP index (with instant answers) plus live evidence extracted from the top ' +
      'results probed in background tabs. ' +
      'Paywalls, cookie walls, and login gates are detected and flagged automatically. ' +
      'If it returns "no results", the reason (timeout / bot-challenge / empty) is included — ' +
      'on a transient failure retry or fetch_page one of your earlier hits rather than rephrasing blindly. ' +
      'Use fetch_page when you need a deeper read of a specific URL beyond what the evidence already provides.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Max SERP hits to return (1–8). Default 4.' },
        digest_top: { type: 'number', description: 'Top hits to probe for live evidence (0–3). Default 2.' },
        focus: { type: 'string', description: 'Optional keyword to weight excerpt selection.' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_page',
    description:
      'Open a specific URL in the visible tab, wait for navigation to settle, and return a bounded page digest. ' +
      'Use when you already have a URL (from search results or the user) and need a deeper read.',
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
  }
]
