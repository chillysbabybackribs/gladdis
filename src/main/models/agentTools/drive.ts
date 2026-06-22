import type { ToolDef } from '../browserTools'

/**
 * DRIVE tools — blind actions (navigate / click / type / press / cdp).
 * Return only ack strings; the LLM never sees raw page data from these.
 * Read with `read_page` afterwards.
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
  }
]
