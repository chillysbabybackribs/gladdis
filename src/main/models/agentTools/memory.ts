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
    },
    outputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: [
            'tool_call_result',
            'conversation_transcript',
            'saved_conversation_list',
            'saved_conversation_search',
            'lineage_overview',
            'lineage_search'
          ]
        },
        scope: { type: 'string', enum: ['conversation', 'all'] },
        query: { type: 'string' },
        conversationId: { type: 'string' },
        toolCallId: { type: 'string' },
        title: { type: 'string' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        hitCount: { type: 'number' },
        totalConversations: { type: 'number' },
        resultText: { type: 'string' },
        summary: { type: 'string' },
        conversations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
              summary: { type: 'string' },
              source: { type: 'string' },
              messageCount: { type: 'number' }
            },
            required: ['id', 'title', 'updatedAt']
          }
        },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              conversationId: { type: 'string' },
              title: { type: 'string' },
              updatedAt: { type: 'string' },
              summary: { type: 'string' },
              role: { type: 'string' },
              messageIndex: { type: 'number' },
              excerpt: { type: 'string' },
              source: { type: 'string' },
              text: { type: 'string' },
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tool: { type: 'string' },
                    status: { type: 'string' },
                    preview: { type: 'string' }
                  },
                  required: ['tool', 'status']
                }
              }
            },
            required: ['conversationId', 'title']
          }
        },
        transcript: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              text: { type: 'string' },
              index: { type: 'number' },
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tool: { type: 'string' },
                    status: { type: 'string' },
                    preview: { type: 'string' }
                  },
                  required: ['tool', 'status']
                }
              }
            },
            required: ['role', 'text', 'index']
          }
        }
      },
      required: ['mode']
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        taskId: { type: 'string' },
        key: { type: 'string' },
        value: {},
        conversationId: { type: 'string' },
        action: { type: 'string', enum: ['written'] }
      },
      required: ['scope', 'key', 'value', 'action']
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        taskId: { type: 'string' },
        label: { type: 'string' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        values: {
          type: 'object',
          additionalProperties: true
        }
      },
      required: ['scope', 'values']
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        taskId: { type: 'string' },
        label: { type: 'string' },
        updatedAt: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'string' }
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              updatedAt: { type: 'string' }
            },
            required: ['id', 'updatedAt']
          }
        }
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['workspace', 'task'] },
        taskId: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'string' }
        },
        deletedTask: { type: 'boolean' },
        action: { type: 'string', enum: ['forgot'] }
      },
      required: ['scope', 'action']
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        label: { type: 'string' },
        createdAt: { type: 'string' }
      },
      required: ['taskId', 'label', 'createdAt']
    }
  }
]
