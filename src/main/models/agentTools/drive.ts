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
      'Navigate the active browser tab to a URL and ack on load settle. ' +
      'Call read_page afterwards if you need the page content.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to load.' },
        wait: {
          type: 'boolean',
          description: 'Wait for page-load settle before returning (default true).'
        },
        timeout_ms: {
          type: 'number',
          description: 'Maximum wait time in milliseconds when wait=true.'
        }
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'number' }
      },
      required: ['url', 'wait', 'timeoutMs']
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
    },
    outputSchema: {
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        charsTyped: { type: 'number' }
      },
      required: ['text', 'charsTyped']
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
    },
    outputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key']
    }
  },
  {
    name: 'execute_in_browser',
    description:
      'Run JavaScript in the active page. Use `return <expr>` for a value. ' +
      'Prefer read_page for state checks; use this for targeted DOM edits/mutations or scalar reads.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript. Use `return` to yield a value.' }
      },
      required: ['code']
    },
    outputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        result: {}
      },
      required: ['code', 'result']
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        params: { type: 'object' },
        result: {}
      },
      required: ['method', 'result']
    }
  },
  {
    name: 'grep_click',
    description:
      'Find a selector/XPath/text match and click it in one step.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'CSS selector, XPath, or unique text to match.'
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' }
          },
          required: ['x', 'y']
        },
        match: {
          type: 'object',
          properties: {
            tagName: { type: 'string' },
            selector: { type: 'string' },
            matchedLine: { type: 'string' }
          }
        }
      },
      required: ['query', 'type', 'caseSensitive', 'coordinates', 'match']
    }
  },
  {
    name: 'grep_type',
    description:
      'Find an input/textarea by selector or text, focus it, and type in one step.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'CSS selector, XPath, or nearby/placeholder text to match the input.'
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        text: { type: 'string' },
        type: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        coordinates: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' }
          },
          required: ['x', 'y']
        },
        match: {
          type: 'object',
          properties: {
            tagName: { type: 'string' },
            selector: { type: 'string' },
            matchedLine: { type: 'string' }
          }
        }
      },
      required: ['query', 'text', 'type', 'caseSensitive', 'coordinates', 'match']
    }
  }
]
