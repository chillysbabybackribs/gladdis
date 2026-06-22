import type { ToolDef } from '../browserTools'

/**
 * TASK — multi-step pipeline. `browse_task` is one tool call; the
 * deterministic Planner+Runner drives the browser to completion.
 */
export const TASK_TOOLS: ToolDef[] = [
  {
    name: 'browse_task',
    description:
      'Execute a multi-step browser task end-to-end using a deterministic pipeline.\n' +
      'The pipeline:\n' +
      '  1. Reads the current page once (deterministic)\n' +
      '  2. Asks the model to plan ALL steps up front\n' +
      '  3. Executes each step with CDP, verifying post-conditions deterministically\n' +
      '  4. Returns a concise synthesis of what was found/done\n\n' +
      'Use this instead of manually sequencing navigate/click/read_page calls ' +
      'whenever the task requires 2+ interactions (form fills, searches, ' +
      'multi-page flows, login sequences, scraping a list, etc.).\n\n' +
      'The returned answer contains only synthesized facts — no raw HTML, ' +
      'no action tables, no screenshots.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Plain-language description of what to accomplish. Be specific: include target URLs, search terms, values to fill, data to extract.'
        },
        site: {
          type: 'string',
          description: 'Optional human label for the site (e.g. "GitHub"). Helps the planner.'
        }
      },
      required: ['task']
    }
  }
]
