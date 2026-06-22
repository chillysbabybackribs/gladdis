import type { ToolDef } from '../browserTools'

/**
 * MEMORY — `recall_history` for past conversations and the working
 * memory triplet (`memory_*`) for ad-hoc workspace + per-task scratchpads.
 */
export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: 'recall_history',
    description:
      'Retrieve earlier parts of saved chat history from disk. ' +
      'By default this searches the current conversation chain. Pass scope:"all" ' +
      'without a query to list recent saved chat summaries, or with a query to search older chats. ' +
      'Pass conversation_id ' +
      'to read a saved conversation in full when the summary is not enough. ' +
      'For a bare resume request, use this to recover context, then summarize what you found and wait for the next concrete instruction before taking state-changing actions. ' +
      'Pass tool_call_id to re-read a specific earlier tool result in full.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for in earlier turns.' },
        conversation_id: { type: 'string', description: 'Saved Gladdis conversation id to read in full.' },
        tool_call_id: { type: 'string', description: 'Id of an earlier tool call to re-read verbatim.' },
        scope: {
          type: 'string',
          enum: ['conversation', 'all'],
          description: 'Search the current conversation chain, or all saved chats when explicitly needed.'
        }
      }
    }
  },
  {
    name: 'memory_write',
    description:
      'Write or update entries in working memory. Use scope:"workspace" for project-level state ' +
      'or scope:"task" + task_id for per-task memory.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        task_id: { type: 'string', description: 'Required when scope is "task"' },
        key: { type: 'string' },
        value: { type: 'object' }
      },
      required: ['scope', 'key', 'value']
    }
  },
  {
    name: 'memory_read',
    description: 'Read specific keys from working memory. Supports selective retrieval to keep token usage low.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        task_id: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } }
      },
      required: ['scope']
    }
  },
  {
    name: 'memory_list',
    description: 'List available keys and summaries in workspace or task memory.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        task_id: { type: 'string' }
      },
      required: ['scope']
    }
  },
  {
    name: 'memory_forget',
    description: 'Delete specific keys or an entire task scope.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        task_id: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } }
      },
      required: ['scope']
    }
  },
  {
    name: 'memory_create_task',
    description: 'Create a new isolated task memory scope and return its task_id.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Optional human-readable label for the task' }
      }
    }
  }
]
