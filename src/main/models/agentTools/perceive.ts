import type { ToolDef } from '../browserTools'

const READ_PAGE_CACHE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['hit', 'miss'] },
    capturedAt: { type: 'number' },
    hits: { type: 'number' },
    misses: { type: 'number' },
    expired: { type: 'number' },
    evictions: { type: 'number' },
    size: { type: 'number' },
    limit: { type: 'number' },
    ttlMs: { type: 'number' }
  },
  required: ['status', 'capturedAt', 'hits', 'misses', 'expired', 'evictions', 'size', 'limit', 'ttlMs']
} as const

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
    },
    outputSchema: {
      type: 'object',
      properties: {
        pageUrl: { type: 'string' },
        focus: { type: 'string' },
        viewportOnly: { type: 'boolean' },
        cache: READ_PAGE_CACHE_SCHEMA
      },
      required: ['pageUrl', 'viewportOnly', 'cache']
    }
  },
  {
    name: 'grep_page',
    description:
      'Find a specific element or text section on the live page — fast and precise, ' +
      'and far cheaper than read_page or a screenshot. This is the primary tool for ' +
      '"find/locate X on this page" and for answering "what does the page say about X", ' +
      'especially on long, text-heavy pages. ' +
      'Use type "text" or "regex" when you want page words and surrounding context. ' +
      'Search a full sentence or a distinctive phrase taken from what the user ' +
      'actually wants to know (type "text"/"regex") — NOT a single common word. A bare ' +
      'keyword like "Germany" or "price" floods with dozens of noise hits and answers ' +
      'nothing; a phrase like "Germany surrendered on 8 May 1945" lands the exact passage. ' +
      'Run a few phrasing variations that pertain to the need. Each match returns the ' +
      'surrounding section, so the answer comes back without reading the rest. (A distinctive ' +
      'single word — a rare proper noun, error code, or identifier — is fine; it is common ' +
      'words that are the problem.) ' +
      'Use type "selector" only for a specific CSS selector or XPath when you are targeting ' +
      'a known DOM element to inspect or act on. ' +
      'AVOID broad tag selectors like "a", "div", "img", "script" — every match returns full ' +
      'outerHTML + selector + coordinates, so a broad selector dumps the page and defeats the ' +
      'token savings; narrow the query instead.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The text query or regular expression or CSS selector/XPath pattern to search/grep for.'
        },
        type: {
          type: 'string',
          enum: ['text', 'regex', 'selector'],
          description: 'Search type. Use "text" for literal page text and context, "regex" for text patterns, or "selector" for CSS selectors/XPath. Defaults to "text".'
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        contextLines: { type: 'number' },
        totalMatches: { type: 'number' },
        truncated: { type: 'boolean' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              matchedLine: { type: 'string' },
              lineIndex: { type: 'number' },
              context: { type: 'string' },
              selector: { type: 'string' },
              visible: { type: 'boolean' },
              tagName: { type: 'string' },
              outerHTML: { type: 'string' },
              innerText: { type: 'string' },
              coordinates: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  top: { type: 'number' },
                  left: { type: 'number' }
                },
                required: ['x', 'y', 'width', 'height', 'top', 'left']
              }
            },
            required: ['type']
          }
        }
      },
      required: ['query', 'type', 'caseSensitive', 'contextLines', 'matches']
    }
  },
  {
    name: 'watch_network',
    description:
      'Read the structured data a page is built from — the JSON behind the render, ' +
      'not the rendered HTML. PASSIVELY observes the network traffic the current ' +
      'page emits ON ITS OWN for a short window and returns the captured endpoints ' +
      'plus their response bodies (size-capped). Use this when the answer is data the ' +
      'page loads from an API (search results, listings, prices, tables, feeds) — ' +
      'one captured API response often beats many scroll-and-grep cycles, and gives ' +
      'complete un-paginated data. Passive: it only sees traffic the page fires by ' +
      'itself, so if the page is idle, trigger the load first (navigate/scroll/click) ' +
      'then watch. Focus with url_filter/url_filters/url_regex plus optional resource_types, ' +
      'status_codes or status_min/status_max, and mime_includes to keep relevant calls and ' +
      'skip noise. Returns request/response metadata, bounded timing, and a few capped bodies. Not ' +
      'for static pages with no API.',
    parameters: {
      type: 'object',
      properties: {
        url_filter: {
          type: 'string',
          description: 'Case-insensitive substring to keep only matching request URLs (e.g. "/api/", "graphql", "search").'
        },
        url_filters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of case-insensitive substrings; a request is kept if any entry matches its URL.'
        },
        url_regex: {
          type: 'string',
          description: 'Optional case-insensitive regex pattern applied to request URLs.'
        },
        resource_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional resource types to keep, e.g. ["xhr", "fetch", "document"].'
        },
        status_codes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional exact HTTP statuses to keep, e.g. [200, 204, 304].'
        },
        status_min: {
          type: 'number',
          description: 'Optional minimum HTTP status to keep, between 100 and 599.'
        },
        status_max: {
          type: 'number',
          description: 'Optional maximum HTTP status to keep, between 100 and 599.'
        },
        mime_includes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional case-insensitive substrings that must match the response mime type, e.g. ["json", "javascript"].'
        },
        include_request_body: {
          type: 'boolean',
          description: 'If true, include bounded previews of POST/PUT/PATCH request payloads when available.'
        },
        redact_sensitive: {
          type: 'boolean',
          description: 'If false, disables the default redaction of sensitive headers and payload fields.'
        },
        window_ms: {
          type: 'number',
          description: 'How long to observe, in ms. Default 4000, max 15000.'
        },
        max_bodies: {
          type: 'number',
          description: 'Max number of response bodies to return. Default 3, max 10.'
        },
        max_body_chars: {
          type: 'number',
          description: 'Per-body character cap. Default 4000, max 20000.'
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        urlFilter: { type: 'string' },
        urlFilters: {
          type: 'array',
          items: { type: 'string' }
        },
        urlRegex: { type: 'string' },
        resourceTypes: {
          type: 'array',
          items: { type: 'string' }
        },
        statusCodes: {
          type: 'array',
          items: { type: 'number' }
        },
        statusMin: { type: 'number' },
        statusMax: { type: 'number' },
        mimeIncludes: {
          type: 'array',
          items: { type: 'string' }
        },
        includeRequestBody: { type: 'boolean' },
        redactSensitive: { type: 'boolean' },
        windowMs: { type: 'number' },
        totalSeen: { type: 'number' },
        captured: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requestId: { type: 'string' },
              url: { type: 'string' },
              method: { type: 'string' },
              status: { type: 'number' },
              mimeType: { type: 'string' },
              type: { type: 'string' },
              requestHeaders: {
                type: 'object',
                additionalProperties: { type: 'string' }
              },
              responseHeaders: {
                type: 'object',
                additionalProperties: { type: 'string' }
              },
              requestBody: { type: 'string' },
              requestBodyTruncated: { type: 'boolean' },
              startedAt: { type: 'number' },
              responseReceivedAt: { type: 'number' },
              finishedAt: { type: 'number' },
              durationMs: { type: 'number' },
              encodedDataLength: { type: 'number' },
              success: { type: 'boolean' },
              errorText: { type: 'string' }
            },
            required: ['requestId', 'url', 'method', 'status', 'mimeType', 'type', 'success']
          }
        },
        bodies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requestId: { type: 'string' },
              url: { type: 'string' },
              status: { type: 'number' },
              mimeType: { type: 'string' },
              body: { type: 'string' },
              truncated: { type: 'boolean' }
            },
            required: ['requestId', 'url', 'status', 'mimeType', 'body', 'truncated']
          }
        }
      },
      required: ['windowMs', 'totalSeen', 'captured', 'bodies']
    }
  }
]

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
    },
    outputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', const: 'active_tab' },
        fullPage: { type: 'boolean' },
        mimeType: { type: 'string', const: 'image/png' }
      },
      required: ['target', 'fullPage', 'mimeType']
    }
  },
  {
    name: 'screenshot_app',
    description:
      'Capture the full Gladdis app window (chat + browser) as an image. ' +
      'Use this for complete app state checks.',
    parameters: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', const: 'app_window' },
        mimeType: { type: 'string', const: 'image/png' }
      },
      required: ['target', 'mimeType']
    }
  }
]
