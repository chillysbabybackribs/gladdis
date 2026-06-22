import type { ToolDef } from '../browserTools'

/**
 * DRIVE tools — low-level browser actions.
 * Prefer grep_page / grep_click / grep_type for discovery + action.
 * Use click_xy, type_text, press_key, execute_in_browser, and cdp_command only when a direct grep action is not suitable.
 * Return only ack strings; the LLM never sees raw page data from these.
 * Read with `read_page` afterwards when you need page state.
 */
export const DRIVE_TOOLS: ToolDef[] = [
  {
    name: 'navigate',
    description:
      'Navigate the active browser tab to a URL. ' +
      'Returns an ack when the page-load event fires. ' +
      'Call read_page afterwards to see the page content.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to load.' } },
      required: ['url']
    }
  },
  {
    name: 'click_xy',
    description:
      'Trusted mouse click at viewport coordinates (x, y). ' +
      'Get coordinates from the ACTIONS table in the last read_page digest.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y']
    }
  },
  {
    name: 'type_text',
    description: 'Type text into the focused element. Click the target first.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'press_key',
    description:
      'Press a single key: Enter, Tab, Escape, Backspace, Delete, ' +
      'ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name, e.g. "Enter".' } },
      required: ['key']
    }
  },
  {
    name: 'execute_in_browser',
    description:
      'Run JavaScript in the active page. Use `return <expr>` to get a value. ' +
      'For reading page state prefer read_page (cheaper); use this for surgical ' +
      'DOM mutations, form fills, or extracting a specific scalar value.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript. Use `return` to yield a value.' }
      },
      required: ['code']
    }
  },
  {
    name: 'cdp_command',
    description:
      'Send a raw Chrome DevTools Protocol command. Escape hatch for advanced ' +
      'control (network interception, emulation, etc.).',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        params: { type: 'object', description: 'CDP params.' }
      },
      required: ['method']
    }
  },
  {
    name: 'grep_click',
    description:
      'Search the page for a CSS selector, XPath, or text string, and click the first/best match. ' +
      'Combines discovery and click in a single step to save time and tokens. ' +
      'Returns details of the element that was clicked, or an error if no match was found.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A CSS selector (e.g., "button.primary", "#login-btn"), XPath, or a unique text substring to search for.'
        },
        type: {
          type: 'string',
          enum: ['auto', 'text', 'regex', 'selector'],
          description: 'Search mode. "auto" detects if query looks like a CSS selector/XPath, else searches by text.'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case sensitivity for text/regex searches. Defaults to false.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'grep_type',
    description:
      'Search the page for an input/textarea element by selector or text, click it to focus, and type the specified text into it. ' +
      'Combines discovery, clicking/focusing, and typing in a single action to save time and tokens. ' +
      'Returns details of the matched element, or an error if no match was found.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A CSS selector, XPath, or adjacent/placeholder text substring to search for the input element.'
        },
        text: {
          type: 'string',
          description: 'The text to type into the matching input element.'
        },
        type: {
          type: 'string',
          enum: ['auto', 'text', 'regex', 'selector'],
          description: 'Search mode. "auto" detects if query looks like a CSS selector/XPath, else searches by text.'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case sensitivity for text/regex searches. Defaults to false.'
        }
      },
      required: ['query', 'text']
    }
  }
]
