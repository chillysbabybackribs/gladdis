import type { ToolDef } from '../browserTools'

/**
 * DRIVE tools — browser actions.
 * `act` is the companion action verb (resolve a target + act + return fresh
 * state in one call). It works best after navigate/grep_page/read_a11y have
 * already oriented the model to the right control. Use execute_in_browser /
 * cdp_command only when a direct act is not suitable. grep_click / grep_type
 * remain as the legacy split verbs.
 */
export const DRIVE_TOOLS: ToolDef[] = [
  {
    name: 'act',
    description:
      'Do one browser action on the visible tab AND get the page\'s fresh state back ' +
      'in the same call — no separate read needed afterwards. Use it as a companion ' +
      'to navigate/grep_page/read_a11y, not as your first orientation tool. ' +
      'kind: "click" | "type" | "key" | "select". ' +
      'Target an element by (preferred) a read_a11y @ref, or a `query` (text/CSS/XPath ' +
      'resolved live on the page), or explicit `coords` {x,y}. For kind "type" pass `text`; ' +
      'the text is inserted in one shot, not typed letter-by-letter. ' +
      'for "key" pass `key` (Enter, Tab, Escape, Arrow*, …) and no target; for "select" pass ' +
      '`option` (the label or value to choose). ' +
      'Resolution is exact (literal node + literal coordinate), never guessed. If the target ' +
      'no longer resolves, the call fails with a re-orient hint instead of clicking the wrong ' +
      'thing — re-run read_a11y/grep_page and target a fresh @ref from the current tab snapshot. ' +
      'The returned `after` field reports the new url/title/readyState/focus so you can confirm ' +
      'the action landed without calling read_page/read_a11y again. When an action navigates to a new ' +
      'page, `after.navigated` is true and `after.elements` lists the new page\'s top clickable targets ' +
      'with coordinates — act on those directly instead of re-reading. ' +
      'To load a URL, use navigate() — do NOT pass a URL as an act query; act targets on-page elements, not links by their address.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['click', 'type', 'key', 'select'],
          description: 'The action to perform.'
        },
        ref: { type: 'string', description: 'read_a11y ref like @a1 (preferred target).' },
        query: {
          type: 'string',
          description: 'Text, CSS selector, or XPath to resolve the target live. Used when no ref.'
        },
        type: {
          type: 'string',
          enum: ['text', 'regex', 'selector'],
          description: 'How to interpret `query`. Defaults to "text".'
        },
        caseSensitive: { type: 'boolean', description: 'Case sensitivity for text/regex query. Default false.' },
        coords: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description: 'Explicit viewport coordinates (last-resort target).'
        },
        text: { type: 'string', description: 'For kind "type": the text to type into the focused target.' },
        key: { type: 'string', description: 'For kind "key": the key name, e.g. "Enter".' },
        option: { type: 'string', description: 'For kind "select": the option label or value to choose.' }
      },
      required: ['kind']
    },
    outputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        text: { type: 'string' },
        key: { type: 'string' },
        option: { type: 'string' },
        coordinates: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y']
        },
        match: { type: 'object' },
        after: {
          type: 'object',
          properties: {
            url: { type: ['string', 'null'] },
            title: { type: 'string' },
            readyState: { type: 'string' },
            bodyTextChars: { type: 'number' },
            activeElement: { type: ['string', 'null'] },
            navigated: { type: 'boolean' },
            elements: {
              type: 'array',
              description: 'On navigation, the new page\'s top interactive targets — act on these directly without a re-read.',
              items: {
                type: 'object',
                properties: {
                  tag: { type: 'string' },
                  role: { type: ['string', 'null'] },
                  label: { type: 'string' },
                  x: { type: 'number' },
                  y: { type: 'number' }
                }
              }
            },
            captured: { type: 'boolean' }
          }
        }
      },
      required: ['kind', 'after']
    }
  },
  {
    name: 'navigate',
    description:
      'Navigate the active tab to a URL and land ORIENTED — the result is a page brief, ' +
      'not just an ack. It returns: the effective URL after any redirect (spot a login wall / ' +
      'regional bounce), the load/readyState, a page-text size hint, a WIREFRAME of the page in ' +
      'DOCUMENT ORDER (interactive elements top-to-bottom exactly as they appear, each with an ' +
      'idx and href — the first listed is the first on the page, so "the top X" is the first X; ' +
      'nothing is ranked, YOU decide what matters), AND it SAVES THE WHOLE CLEANED PAGE TO DISK. ' +
      'The result gives the file paths (a .md of the readable content and a .actions.json of the ' +
      'interactive elements) — read or grep those LOCAL files for the full content instead of ' +
      're-fetching the page. Long runs of repetitive items (timestamps, "N comments") collapse ' +
      'in place to "[N× role idx a–b]" without breaking order. For exact text on the live page, ' +
      'grep_page still works; use read_a11y only for control-heavy component UIs.',
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
        url: { type: 'string', description: 'Effective URL after any redirect.' },
        requestedUrl: { type: 'string' },
        redirected: { type: 'boolean' },
        readyState: { type: ['string', 'null'] },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'number' },
        pageTextChars: { type: ['number', 'null'] },
        savedMarkdownPath: { type: 'string', description: 'Local .md of the cleaned readable page — read/grep it.' },
        savedActionsPath: { type: 'string', description: 'Local .actions.json of DOM-order interactive elements.' },
        dataSourceDiscovery: {
          type: 'object',
          description: 'When navigation was network-armed, a quick summary of whether the page looks server-rendered, API-backed, or mixed.',
          properties: {
            pageUrl: { type: 'string' },
            capturedAt: { type: 'number' },
            observedWindowMs: { type: 'number' },
            totalSeen: { type: 'number' },
            matchedCount: { type: 'number' },
            pageMode: { type: 'string' },
            botProtectionSuspected: { type: 'boolean' },
            recommendation: { type: 'string' },
            candidateApis: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  method: { type: 'string' },
                  status: { type: 'number' },
                  type: { type: 'string' },
                  mimeType: { type: 'string' },
                  kind: { type: 'string' },
                  auth: { type: 'string' },
                  score: { type: 'number' }
                }
              }
            }
          }
        },
        wireframe: {
          type: 'object',
          description: 'Page interactive elements in DOCUMENT ORDER (not ranked). "top" = first line.',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            totalActions: { type: 'number' },
            truncated: { type: 'boolean' },
            headings: {
              type: 'array',
              items: { type: 'object', properties: { level: { type: 'number' }, text: { type: 'string' } } }
            },
            lines: {
              type: 'array',
              description: 'Each line is one element (kind:"action") or a collapsed repetitive run (kind:"group").',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['action', 'group'] },
                  idx: { type: 'number' },
                  role: { type: 'string' },
                  name: { type: 'string' },
                  href: { type: 'string' },
                  count: { type: 'number' },
                  idxStart: { type: 'number' },
                  idxEnd: { type: 'number' }
                }
              }
            }
          }
        }
      },
      required: ['url', 'wait', 'timeoutMs']
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
      'Find a selector/XPath/text match or read_a11y ref (@a1) and click it in one step.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'CSS selector, XPath, unique text, or read_a11y ref like @a1.'
        },
        type: {
          type: 'string',
          enum: ['text', 'regex', 'selector', 'ref'],
          description: 'Search mode. Use "ref" or pass @aN directly after read_a11y. Defaults to "text".'
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
      'Find an input/textarea by selector, text, or read_a11y ref (@a1), focus it, and type in one step.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'CSS selector, XPath, nearby/placeholder text, or read_a11y ref like @a1.'
        },
        text: {
          type: 'string',
          description: 'The text to type into the matching input element.'
        },
        type: {
          type: 'string',
          enum: ['text', 'regex', 'selector', 'ref'],
          description: 'Search mode. Use "ref" or pass @aN directly after read_a11y. Defaults to "text".'
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
