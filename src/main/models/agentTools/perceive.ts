import type { ToolDef } from '../browserTools'

/**
 * PERCEIVE — `read_page`. The LLM calls this to read the current page.
 * Internally runs the deterministic PageExtractor and formats through
 * PageDigest. The LLM receives a clean structured digest, never raw HTML.
 */
export const PERCEIVE_TOOLS: ToolDef[] = [
  {
    name: 'read_page',
    description:
      'Read a bounded active-tab digest: URL/title, summary, structure, and action table.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Keyword to rank relevant actions higher (e.g. "login", "search").'
        },
        viewportOnly: {
          type: 'boolean',
          description: 'If true, only include actions currently visible in the viewport.'
        }
      }
    }
  },
  {
    name: 'grep_page',
    description:
      'Search live page text, CSS selectors, or XPath with context and coordinates for fast discovery.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text query or regular expression or CSS selector/XPath pattern to search/grep for.'
        },
        type: {
          type: 'string',
          enum: ['text', 'regex', 'selector', 'auto'],
          description: "Search type: 'text', 'regex', 'selector', or 'auto' (default)."
        },
        contextLines: {
          type: 'number',
          description: 'Number of context lines to return around any text matches (like grep -C). Defaults to 2.'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether text/regex match should be case-sensitive. Defaults to false.'
        }
      },
      required: ['query']
    }
  }
]

/**
 * CAPTURE — visual screenshot tools. Prefer `read_page` for understanding;
 * use these when a visual is genuinely needed.
 */
export const CAPTURE_TOOLS: ToolDef[] = [
  {
    name: 'screenshot',
    description:
      'Capture a PNG of the active tab. Use this to confirm rendering. ' +
      'opts.fullPage: true captures whole scrollable content.',
    parameters: {
      type: 'object',
      properties: {
        fullPage: {
          type: 'boolean',
          description: 'If true, capture the entire scrollable page instead of just the viewport.'
        }
      }
    }
  },
  {
    name: 'screenshot_app',
    description:
      'Capture the full Gladdis app window (chat + browser) as an image. ' +
      'Use this for complete app state checks.',
    parameters: { type: 'object', properties: {} }
  }
]
