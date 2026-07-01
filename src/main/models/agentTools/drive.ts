import type { ToolDef } from '../browserTools'

/**
 * DRIVE tools — browser actions.
 * Higher-level browser verbs come first: set_field / submit / open_result.
 * `act` remains the companion low-level action verb (resolve a target + act +
 * return fresh state in one call) when the semantic verbs do not fit. Use
 * execute_in_browser / cdp_command only when a direct interaction tool is not
 * suitable. grep_click / grep_type remain as the legacy split verbs.
 */
export const DRIVE_TOOLS: ToolDef[] = [
  {
    name: 'set_field',
    description:
      'Set the value of an input, textarea, select, or contenteditable field in one semantic step, then return the page\'s fresh state. ' +
      'Use this instead of raw typing when the goal is "fill this field". Target by (preferred) a read_a11y @ref, or a `query` ' +
      '(text/CSS/XPath resolved live on the page), or explicit `coords` {x,y}. Pass `value` to set. ' +
      'By default it replaces the current value; set `clear:false` to append instead. For selects it chooses the matching option label/value. ' +
      'The returned `after` field reports the new url/title/readyState/focus so you can confirm the field was set without a separate read.',
    parameters: {
      type: 'object',
      properties: {
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
        value: { type: 'string', description: 'The value to set on the resolved field.' },
        clear: { type: 'boolean', description: 'Replace the existing value first (default true). Set false to append.' }
      },
      required: ['value']
    },
    outputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        clear: { type: 'boolean' },
        mode: { type: 'string' },
        coordinates: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y']
        },
        match: { type: 'object' },
        after: { type: 'object' }
      },
      required: ['value', 'clear', 'mode', 'coordinates', 'match', 'after']
    }
  },
  {
    name: 'submit',
    description:
      'Submit the current form or activate a targeted submit control, then return the page\'s fresh state. ' +
      'Use this when the user intent is "submit/search/send/save" rather than "click this exact thing". ' +
      'With no target it tries the nearest form around the current focus first, then falls back to Enter. ' +
      'You may also target a specific submit button via read_a11y @ref, `query`, or `coords`.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'read_a11y ref like @a1.' },
        query: {
          type: 'string',
          description: 'Text, CSS selector, or XPath to resolve a specific submit control.'
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
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        label: { type: 'string' },
        coordinates: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y']
        },
        match: { type: 'object' },
        after: { type: 'object' }
      },
      required: ['after']
    }
  },
  {
    name: 'open_result',
    description:
      'Open a matching result, card, headline, or list item from the current page, then return the page\'s fresh state. ' +
      'Use this for "open the first result" or "open the third matching story" instead of manually clicking. ' +
      'Pass a `query` plus optional `index` (1-based, default 1). You may also target by read_a11y @ref or `coords` when there is only one result to open.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'read_a11y ref like @a1.' },
        query: {
          type: 'string',
          description: 'Text, CSS selector, or XPath to resolve the result to open.'
        },
        type: {
          type: 'string',
          enum: ['text', 'regex', 'selector'],
          description: 'How to interpret `query`. Defaults to "text".'
        },
        caseSensitive: { type: 'boolean', description: 'Case sensitivity for text/regex query. Default false.' },
        index: { type: 'number', description: '1-based match index when multiple visible results match. Defaults to 1.' },
        coords: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description: 'Explicit viewport coordinates (last-resort target).'
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        index: { type: 'number' },
        coordinates: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y']
        },
        match: { type: 'object' },
        after: { type: 'object' }
      },
      required: ['coordinates', 'match', 'after']
    }
  },
  {
    name: 'act',
    description:
      'Do one browser action on the visible tab AND get the page\'s fresh state back ' +
      'in the same call — no separate read needed afterwards. Use it as a companion ' +
      'to navigate/grep_page/read_a11y, and prefer `set_field`, `submit`, or `open_result` when those semantic verbs fit better. ' +
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
      'To load a URL, use navigate() — do NOT pass a URL as an act query; act targets on-page elements, not links by their address. ' +
      'FUSION: pass `navigate` (a URL) to load that page, WAIT for it to settle, THEN do this action on it in ONE call — ' +
      'saving the navigate→act round-trip. Because the page is loaded by this same call, target it by `query` (text/CSS/XPath) ' +
      'or `coords`, NOT by a @ref/idx (those do not exist until after the load). It fails safe: if the page does not load, or ' +
      'the target is not found on the settled page, it returns ok:false with the landed URL and a re-orient hint — it never ' +
      'clicks a guess. Tune the settle wait with `settle_ms` (default 3000).',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['click', 'type', 'key', 'select'],
          description: 'The action to perform.'
        },
        navigate: {
          type: 'string',
          description:
            'Optional URL to load (and wait to settle) BEFORE performing this action, fusing navigate→act into one call. ' +
            'When set, target the action by `query`/`coords` only (a @ref/idx cannot predate this load).'
        },
        settle_ms: {
          type: 'number',
          description: 'When `navigate` is set, how long (ms, 0–15000, default 3000) to wait for the loaded page to settle before acting.'
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
