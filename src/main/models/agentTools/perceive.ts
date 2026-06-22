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
      'Read the current page. Returns a structured, token-bounded digest:\n' +
      '  • URL, title, word count\n' +
      '  • Content summary (first ~450 tokens of readable text)\n' +
      '  • Headings outline\n' +
      '  • OG / meta structured data\n' +
      '  • Interactive actions table (up to 80 rows): index, role, label, ' +
      '    viewport coordinates (x, y), selector — everything needed to drive\n' +
      '  • Key links\n' +
      'Use the ACTIONS table to get (x, y) coords for click_xy only when you cannot use grep_click or grep_type. Call this once ' +
      'per page; re-call only after an action that changes the page structure.\n' +
      'opts.focus: optional keyword — ranks relevant actions higher in the table.\n' +
      'opts.viewportOnly: true → only show actions visible on screen.',
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
      'Perform a hybrid grep and element search on the full page currently open in the browser tab. ' +
      'This is extremely powerful for finding specific text, keywords, selectors, CSS patterns, or interactive ' +
      'elements (e.g., APIs, prices, keys, links, buttons, input fields) across the entire document without hitting ' +
      'token truncation limits.\n' +
      'It searches the live DOM, returns matching text lines with preceding/succeeding context lines (like grep -C), ' +
      'CSS paths, and pixel coordinates of matched elements so you can instantly interact with them (e.g., click_xy, fill_field, type_text).\n' +
      'Supports auto-detection: if query looks like a CSS selector (e.g., starts with "." or "#", or has "[") or XPath, ' +
      'it queries by selector, otherwise it performs a powerful full-text regex grep search.',
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
          description: "The type of search: 'text' for literal string, 'regex' for regular expression, 'selector' for CSS/XPath. 'auto' (default) automatically detects and combines results."
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
      'Capture a PNG of the active browser tab and return it as an image. ' +
      'Use to visually confirm a page rendered as expected. ' +
      'opts.fullPage: true → capture the whole scrollable page (default: visible viewport).',
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
      "Capture a PNG of the entire Gladdis app window (the chat UI plus the " +
      'embedded browser) and return it as an image. Use to see the whole app ' +
      'state at once — e.g. to check the chat panels and browser together.',
    parameters: { type: 'object', properties: {} }
  }
]
