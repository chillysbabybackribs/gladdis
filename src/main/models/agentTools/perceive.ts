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
      'Orient on the active tab: a bounded, cached structural digest — URL/title, a short ' +
      'summary, the page structure, and a table of the main actions. Use this FIRST when you ' +
      'arrive somewhere new and need the lay of the land, before targeting anything. ' +
      'It is the orientation tool, a different job from grep_page (which finds one exact ' +
      'element or passage) and read_a11y (control discovery on component-heavy UIs). ' +
      'Cached with a short TTL and invalidated on navigation, so repeating it is cheap. ' +
      'For precise targeting or to answer "what does the page say about X", prefer grep_page.',
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
        digest: { type: 'string' },
        cache: READ_PAGE_CACHE_SCHEMA
      },
      required: ['pageUrl', 'viewportOnly', 'digest', 'cache']
    }
  },
  {
    name: 'read_a11y',
    description:
      'Read a compact accessibility-tree snapshot of the active tab via CDP ' +
      'Accessibility.getFullAXTree. Returns semantic role + name + state for ' +
      'interactive controls, with stable refs (@a1, @a2, …) and live coordinates ' +
      'when available. Use read_page first for orientation; reach for read_a11y when you need ' +
      'control discovery on refactored or component-heavy UIs where CSS selectors churn. Returned ' +
      '@a1-style refs can be passed directly to act (the primary action verb). Still use ' +
      'grep_page for exact text passages.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Keyword to rank matching nodes higher (e.g. "login", "submit").'
        },
        viewportOnly: {
          type: 'boolean',
          description: 'If true, only include nodes whose bounds intersect the viewport.'
        },
        interactiveOnly: {
          type: 'boolean',
          description: 'If false, include named non-interactive nodes too. Default true.'
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        pageUrl: { type: 'string' },
        title: { type: 'string' },
        focus: { type: 'string' },
        viewportOnly: { type: 'boolean' },
        interactiveOnly: { type: 'boolean' },
        totalSeen: { type: 'number' },
        truncated: { type: 'boolean' },
        cache: READ_PAGE_CACHE_SCHEMA,
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              role: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'string' },
              states: { type: 'array', items: { type: 'string' } },
              inViewport: { type: 'boolean' },
              bounds: {
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
            required: ['ref', 'role', 'name', 'states', 'inViewport']
          }
        }
      },
      required: ['pageUrl', 'title', 'totalSeen', 'truncated', 'nodes', 'cache']
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
    name: 'extract_structured',
    description:
      'Extract repeated records from the live page as bounded JSON. Use this when the page has a known repeated shape ' +
      '(table rows, cards, search results, comments, feed items) and `grep_page` would require many repeated queries or truncate. ' +
      'Provide ONE specific record selector via `item_selector` or `item_xpath`, then a small `fields` map. Each field can read ' +
      'the whole item or a relative descendant via CSS selector/XPath, returning text, HTML, an attribute, or just whether it exists. ' +
      'Use `read_page` first if you still need orientation, and prefer `watch_network` when the page is clearly driven by JSON/API data. ' +
      'Avoid broad item selectors like `div` or `a`: target the real repeated record node.',
    parameters: {
      type: 'object',
      properties: {
        item_selector: {
          type: 'string',
          description: 'CSS selector that resolves one repeated record per match, e.g. "tr.athing" or "article.search-result".'
        },
        item_xpath: {
          type: 'string',
          description: 'XPath alternative to item_selector when CSS is not expressive enough. Pass only one of item_selector or item_xpath.'
        },
        fields: {
          type: 'object',
          description:
            'Map field names to extraction specs. Example: { "title": { "selector": "a.title", "mode": "text" }, "href": { "selector": "a.title", "mode": "attr", "attr": "href" } }',
          additionalProperties: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              xpath: { type: 'string' },
              scope: {
                type: 'string',
                enum: ['item', 'page'],
                description: 'Resolve selector/xpath relative to the matched item (default) or the whole page.'
              },
              mode: {
                type: 'string',
                enum: ['text', 'attr', 'html', 'exists'],
                description: 'Read normalized text (default), an attribute, bounded HTML, or whether the target exists.'
              },
              attr: {
                type: 'string',
                description: 'Required when mode="attr", e.g. "href", "src", "datetime", or "data-id".'
              }
            }
          }
        },
        limit: {
          type: 'number',
          description: 'Maximum records to return after visibility filtering. Default 20, max 100.'
        },
        include_invisible: {
          type: 'boolean',
          description: 'If true, keep records even when their root element is hidden. Default false.'
        },
        text_limit: {
          type: 'number',
          description: 'Per-field cap for text/attribute values. Default 500, max 4000.'
        },
        html_limit: {
          type: 'number',
          description: 'Per-field cap for HTML values. Default 2000, max 12000.'
        }
      },
      required: ['fields']
    },
    outputSchema: {
      type: 'object',
      properties: {
        itemSelector: { type: 'string' },
        itemXpath: { type: 'string' },
        limit: { type: 'number' },
        includeInvisible: { type: 'boolean' },
        textLimit: { type: 'number' },
        htmlLimit: { type: 'number' },
        totalMatches: { type: 'number' },
        returned: { type: 'number' },
        truncated: { type: 'boolean' },
        fields: { type: 'object' },
        records: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true
          }
        }
      },
      required: ['limit', 'includeInvisible', 'textLimit', 'htmlLimit', 'totalMatches', 'returned', 'truncated', 'fields', 'records']
    }
  },
  {
    name: 'discover_data_sources',
    description:
      'Quickly classify whether the current page looks server-rendered, API-backed, or mixed by observing a short bounded network window and ranking candidate JSON/GraphQL endpoints. ' +
      'Use this early when repeated records might come from APIs (feeds, search results, comments, tables, dashboards) and you want to decide between DOM extraction and network capture before spending turns scraping. ' +
      'Returns page mode, bot-protection suspicion, top candidate endpoints, and a recommended next move.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'If true, ignore any recent cached network-awareness summary and run a fresh bounded observation.'
        },
        url_filter: {
          type: 'string',
          description: 'Optional case-insensitive substring to keep only matching request URLs.'
        },
        url_filters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of URL substrings; a request is kept if any entry matches.'
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
        mime_includes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional case-insensitive substrings that must match the response mime type.'
        },
        status_codes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional exact HTTP statuses to keep.'
        },
        status_min: {
          type: 'number',
          description: 'Optional minimum HTTP status to keep.'
        },
        status_max: {
          type: 'number',
          description: 'Optional maximum HTTP status to keep.'
        },
        include_request_body: {
          type: 'boolean',
          description: 'If true, include bounded request payload previews when available to help spot GraphQL or query schemas.'
        },
        redact_sensitive: {
          type: 'boolean',
          description: 'If false, disables the default redaction of sensitive headers and payload fields.'
        },
        window_ms: {
          type: 'number',
          description: 'How long to observe, in ms. Default 4000, max 15000.'
        },
        max_candidates: {
          type: 'number',
          description: 'Maximum ranked candidate endpoints to return. Default 5, max 8.'
        },
        max_body_chars: {
          type: 'number',
          description: 'Per-body character cap used when sampling response bodies for schema hints.'
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        pageUrl: { type: 'string' },
        capturedAt: { type: 'number' },
        observedWindowMs: { type: 'number' },
        cache: { type: 'string', enum: ['hit', 'miss'] },
        totalSeen: { type: 'number' },
        matchedCount: { type: 'number' },
        pageMode: { type: 'string', enum: ['server_rendered', 'api_backed', 'mixed', 'unknown'] },
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
              kind: { type: 'string', enum: ['json', 'graphql', 'html', 'other'] },
              auth: { type: 'string', enum: ['none', 'cookie', 'header', 'unknown'] },
              score: { type: 'number' },
              durationMs: { type: 'number' },
              encodedDataLength: { type: 'number' },
              sampleKeys: { type: 'array', items: { type: 'string' } },
              requestKeys: { type: 'array', items: { type: 'string' } }
            },
            required: ['url', 'method', 'status', 'type', 'mimeType', 'kind', 'auth', 'score']
          }
        }
      },
      required: ['pageUrl', 'capturedAt', 'cache', 'totalSeen', 'matchedCount', 'pageMode', 'botProtectionSuspected', 'recommendation', 'candidateApis']
    }
  },
  {
    name: 'watch_network',
    description:
      'Read the structured data a page is built from — the JSON behind the render, ' +
      'not the rendered HTML. By default this arms a one-shot capture for the next ' +
      'browser-driving action on the active tab, so watching starts BEFORE the page changes. ' +
      'Set mode=\"passive\" to immediately observe the current page for a short window and return the captured endpoints ' +
      'plus their response bodies (size-capped). Use this when the answer is data the ' +
      'page loads from an API (search results, listings, prices, tables, feeds) — ' +
      'one captured API response often beats many scroll-and-grep cycles, and gives ' +
      'complete un-paginated data. In passive mode it only sees traffic the page fires by ' +
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
        mode: {
          type: 'string',
          enum: ['next_action', 'passive'],
          description: 'Capture mode. Default next_action arms the next browser-driving tool before it acts; passive watches the current page immediately.'
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
        mode: { type: 'string' },
        armed: { type: 'boolean' },
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
      'LAST-RESORT vision fallback. Capture a PNG of the active tab ONLY for genuinely ' +
      'vision-only content — canvas, charts, unlabeled image/icon buttons with no accessible ' +
      'name, or to confirm a page rendered. For "what is this element and where is it" or ' +
      '"what does the page say", grep_page and read_a11y are MORE precise than a screenshot ' +
      '(literal node + literal coordinate vs. pixels you must infer) and far cheaper — reach ' +
      'for them first. opts.fullPage: true captures the whole scrollable content.',
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
      'Capture the full Gladdis app window (chat + browser) as an image. For checking the ' +
      'app\'s own rendered state (e.g. confirming UI is not blank during dev work) — this is ' +
      'app self-inspection, distinct from screenshot which targets web-page content.',
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
