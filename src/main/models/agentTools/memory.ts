import type { ToolDef } from '../browserTools'

/**
 * MEMORY — `recall_history` for past conversations and the working
 * memory triplet (`memory_*`) for ad-hoc workspace + per-task scratchpads.
 */
export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: 'recall_history',
    description:
      'A bare resume request is context recovery only: wait for the next concrete instruction, and avoid auto-continuation after state-changing actions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for in earlier turns.' },
        conversation_id: { type: 'string', description: 'Conversation id to read in full.' },
        tool_call_id: { type: 'string', description: 'Id of an earlier tool call to re-read verbatim.' },
        scope: {
          type: 'string',
          enum: ['conversation', 'all'],
          description: 'Current conversation or all saved chats when requested.'
        }
      }
    }
  },
  {
    name: 'memory_write',
    description:
      'Write or update working-memory entries for workspace or task scope.',
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
    description: 'Read specific keys from working memory. Supports selective retrieval.',
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
    description: 'List keys and summaries in workspace or task memory.',
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
    description: 'Delete specific keys or a full task scope.',
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
    description: 'Create a task memory scope and return its task_id.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Optional human-readable label for the task' }
      }
    }
  }
]
