import type { ToolDef } from '../browserTools'

/**
 * TASK — multi-step pipeline. `browse_task` is one tool call; the
 * deterministic Planner+Runner drives the browser to completion.
 */
export const TASK_TOOLS: ToolDef[] = [
  {
    name: 'browse_task',
    description:
      'Run a 2+ step browser workflow in one call. The pipeline plans and executes deterministically, then returns a synthesized result.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Plain-language goal for the full flow, including targets and expected outcome.'
        },
        site: {
          type: 'string',
          description: 'Optional human label for the site (e.g. "GitHub"). Helps the planner.'
        }
      },
      required: ['task']
    },
    outputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        site: { type: 'string' },
        success: { type: 'boolean' },
        tookMs: { type: 'number' },
        llmCalls: { type: 'number' },
        deterministicChecks: { type: 'number' },
        finalUrl: { type: 'string' },
        finalTitle: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              intent: { type: 'string' }
            }
          }
        }
      },
      required: ['task', 'success', 'tookMs', 'llmCalls', 'deterministicChecks', 'finalUrl', 'finalTitle', 'steps']
    }
  }
]
