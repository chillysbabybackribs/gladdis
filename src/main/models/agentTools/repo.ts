import type { ToolDef } from '../browserTools'

/**
 * REPO — repository intelligence (CapabilityBroker-backed).
 * `repo_overview` for orientation, `search_repo`/`read_spans` for surgical
 * reads, `research_dossier` for Gemini-summarized recon, `verify_change`
 * to gate edits behind validation.
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
    }
  }
]
