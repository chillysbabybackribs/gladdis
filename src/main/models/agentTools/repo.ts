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
      'Build a compact overview of the selected workspace: package name, scripts, top directories, key files, and likely entrypoints. ' +
      'Use at the start of a coding task when you need fast orientation before reading specific files.',
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
      'Search the selected workspace and return compact matches for code or filenames. ' +
      'Use this before broad file reads when locating symbols, modules, or feature areas.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'String or regex-like search query for the workspace.' },
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
      'Read one or more bounded windows from files in the selected workspace. ' +
      'Use after search_repo to inspect exact code regions without broad whole-file reads.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Single-file convenience form: relative path in the selected workspace.'
        },
        start_line: {
          type: 'number',
          description: 'Single-file convenience form: starting line number.'
        },
        end_line: {
          type: 'number',
          description: 'Single-file convenience form: ending line number.'
        },
        items: {
          type: 'array',
          description: 'Multi-span form for reading several precise windows at once.',
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
      'Ask Gemini to synthesize a compact repo reconnaissance dossier for a coding question using bounded workspace evidence. ' +
      'Use when you need a higher-level map of relevant modules before reading or editing specific files.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The engineering question or focus area to investigate in the selected workspace.'
        },
        glob: {
          type: 'string',
          description: 'Optional file glob to bias search and evidence gathering.'
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
      'Run a deterministic validation pass for the selected workspace and emit structured verification state. ' +
      'Use after edits to confirm the change passes the right check or to surface the real blocker.',
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
