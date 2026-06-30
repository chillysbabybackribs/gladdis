import type { ToolDef } from '../browserTools'

const REPO_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    chars: { type: 'number' },
    estimatedTokens: { type: 'number' }
  },
  required: ['chars', 'estimatedTokens']
} as const

const SPAN_COORDINATE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    startLine: { type: 'number' },
    endLine: { type: 'number' }
  },
  required: ['path', 'startLine', 'endLine']
} as const

/**
 * REPO — repository intelligence (CapabilityBroker-backed).
 * `repo_overview` for orientation, `repo_grep_task` for task-shaped targeted
 * grep plus sections, `search_repo`/`read_spans` for surgical reads,
 * `research_dossier` for Gemini-summarized recon, `verify_change` to gate
 * edits behind validation.
 */
export const REPO_TOOLS: ToolDef[] = [
  {
    name: 'repo_overview',
    description:
      'Build a compact workspace orientation: package, scripts, top directories, key files, and likely entrypoints.',
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Optional focus area or task wording to bias the summary toward.'
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        packageManager: { type: ['string', 'null'] },
        packageName: { type: ['string', 'null'] },
        scripts: { type: 'array', items: { type: 'string' } },
        keyFiles: { type: 'array', items: { type: 'string' } },
        topDirectories: { type: 'array', items: { type: 'string' } },
        entryPoints: { type: 'array', items: { type: 'string' } },
        focus: { type: 'string' }
      },
      required: ['workspaceRoot', 'packageManager', 'packageName', 'scripts', 'keyFiles', 'topDirectories', 'entryPoints']
    }
  },
  {
    name: 'search_repo',
    description:
      'Search workspace symbols/modules/filenames, then open focused files next.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'String or regex-like search query for the workspace.' },
        path: {
          type: 'string',
          description: 'Optional subfolder or file path to scope the search, relative to the selected workspace root.'
        },
        glob: {
          type: 'string',
          description: 'Optional file glob to narrow the search, e.g. "*.ts" or "src/**/*.tsx".'
        },
        max_results: {
          type: 'number',
          description: 'Maximum hits to return. Default 8.'
        }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        totalHits: { type: 'number' },
        hits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              kind: { type: 'string' },
              line: { type: 'number' },
              text: { type: 'string' }
            },
            required: ['path', 'kind', 'line', 'text']
          }
        },
        suggestedSpans: { type: 'array', items: SPAN_COORDINATE_SCHEMA },
        context: {
          type: 'object',
          properties: {
            ...REPO_CONTEXT_SCHEMA.properties,
            hitCount: { type: 'number' },
            suggestedSpanCount: { type: 'number' }
          },
          required: ['chars', 'estimatedTokens', 'hitCount', 'suggestedSpanCount']
        }
      },
      required: ['workspaceRoot', 'query', 'totalHits', 'hits', 'suggestedSpans', 'context']
    }
  },
  {
    name: 'repo_grep_task',
    description:
      'Find exact repository sections for a natural-language task by running multiple deterministic query variations in parallel, then returning bounded code spans.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Natural-language task or prompt describing what code sections are needed.'
        },
        path: {
          type: 'string',
          description: 'Optional subfolder or file path to scope the search, relative to the selected workspace root.'
        },
        glob: {
          type: 'string',
          description: 'Optional file glob to narrow the search, e.g. "*.ts" or "src/**/*.tsx".'
        },
        max_variations: {
          type: 'number',
          description: 'Maximum generated query variations. Default 6, max 10.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum code sections to return. Default 5, max 10.'
        }
      },
      required: ['task']
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        task: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        variations: { type: 'array', items: { type: 'string' } },
        hits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              variation: { type: 'string' },
              path: { type: 'string' },
              kind: { type: 'string' },
              line: { type: 'number' },
              text: { type: 'string' }
            },
            required: ['variation', 'path', 'kind', 'line', 'text']
          }
        },
        spans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
              totalLines: { type: 'number' },
              truncated: { type: 'boolean' },
              content: { type: 'string' },
              matchedVariations: { type: 'array', items: { type: 'string' } }
            },
            required: ['path', 'startLine', 'endLine', 'totalLines', 'truncated', 'content', 'matchedVariations']
          }
        },
        context: {
          type: 'object',
          properties: {
            ...REPO_CONTEXT_SCHEMA.properties,
            variationCount: { type: 'number' },
            hitCount: { type: 'number' },
            spanCount: { type: 'number' }
          },
          required: ['chars', 'estimatedTokens', 'variationCount', 'hitCount', 'spanCount']
        }
      },
      required: ['workspaceRoot', 'task', 'variations', 'hits', 'spans', 'context']
    }
  },
  {
    name: 'read_spans',
    description:
      'Read bounded line windows from workspace files, plus multi-span batches.',
    parameters: {
      type: 'object',
    properties: {
        path: {
          type: 'string',
          description: 'Single-file convenience path.'
        },
        start_line: {
          type: 'number',
          description: 'Optional starting line.'
        },
        end_line: {
          type: 'number',
          description: 'Optional ending line.'
        },
        items: {
          type: 'array',
          description: 'Multi-span form for several precise windows.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              start_line: { type: 'number' },
              end_line: { type: 'number' }
            },
            required: ['path']
          }
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
              totalLines: { type: 'number' },
              truncated: { type: 'boolean' },
              defaultWindow: { type: 'boolean' },
              content: { type: 'string' }
            },
            required: ['path', 'startLine', 'endLine', 'totalLines', 'truncated', 'defaultWindow', 'content']
          }
        },
        context: {
          type: 'object',
          properties: {
            ...REPO_CONTEXT_SCHEMA.properties,
            itemCount: { type: 'number' },
            includedLines: { type: 'number' }
          },
          required: ['chars', 'estimatedTokens', 'itemCount', 'includedLines']
        }
      },
      required: ['workspaceRoot', 'items', 'context']
    }
  },
  {
    name: 'research_dossier',
    description:
      'Ask Gemini for a compact repo dossier from bounded evidence before deep edits.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The question or focus area to investigate.'
        },
        glob: {
          type: 'string',
          description: 'Optional file glob to focus evidence gathering.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum repo search hits to gather before synthesis. Default 8.'
        }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        query: { type: 'string' },
        searchedFiles: { type: 'array', items: { type: 'string' } },
        suggestedSpans: { type: 'array', items: SPAN_COORDINATE_SCHEMA },
        context: {
          type: 'object',
          properties: {
            promptChars: { type: 'number' },
            estimatedPromptTokens: { type: 'number' },
            searchSummaryChars: { type: 'number' },
            readSpanChars: { type: 'number' },
            estimatedReadSpanTokens: { type: 'number' },
            suggestedSpanCount: { type: 'number' },
            selectedFileBytes: { type: 'number' },
            estimatedFullFileTokens: { type: 'number' },
            estimatedTokensSavedBySpans: { type: 'number' }
          },
          required: [
            'promptChars',
            'estimatedPromptTokens',
            'searchSummaryChars',
            'readSpanChars',
            'estimatedReadSpanTokens',
            'suggestedSpanCount',
            'selectedFileBytes',
            'estimatedFullFileTokens',
            'estimatedTokensSavedBySpans'
          ]
        }
      },
      required: ['workspaceRoot', 'query', 'searchedFiles', 'suggestedSpans', 'context']
    }
  },
  {
    name: 'verify_change',
    description:
      'Run deterministic workspace validation and return structured verification output. ' +
      'Use after edits to confirm checks pass or to surface the real blocker.',
    parameters: {
      type: 'object',
      properties: {
        check: {
          type: 'string',
          enum: ['typecheck', 'test', 'build', 'check'],
          description: 'Single validation check to run.'
        },
        checks: {
          type: 'array',
          items: { type: 'string', enum: ['typecheck', 'test', 'build', 'check'] },
          description: 'Optional ordered list of validation checks to run.'
        },
        goal: {
          type: 'string',
          description: 'Optional natural-language goal used to choose the best validation check when none is specified.'
        }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        language: { type: 'string', enum: ['node', 'python', 'rust', 'go', 'unknown'] },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              check: { type: 'string', enum: ['typecheck', 'test', 'build', 'check'] },
              ok: { type: 'boolean' },
              output: { type: 'string' }
            },
            required: ['check', 'ok', 'output']
          }
        }
      },
      required: ['workspaceRoot', 'language', 'checks']
    }
  }
]
