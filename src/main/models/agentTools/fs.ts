import type { ToolDef } from '../browserTools'

/**
 * FS — local filesystem + shell.
 * Anything that touches the OS user's local environment lives here. Validation,
 * publish, dev-server, and clipboard are all expressible through run_command.
 */
export const FS_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 file with optional line bounds. Prefer search_files first to locate, ' +
      'then use start_line/end_line for surgical reads. Small files return whole; large files return a bounded preview plus metadata.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number', description: 'First line (1-based).' },
        end_line: { type: 'number', description: 'Last line (inclusive).' },
        full: { type: 'boolean', description: 'Return full file within the hard cap.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description:
      'Create or fully overwrite a file. Parent dirs are created automatically. Prefer edit_file for surgical changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'New file contents.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must be unique and match byte-for-byte. ' +
      'Use replace_all: true to replace every occurrence.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_dir',
    description: 'List immediate entries of a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description:
      'Recursive search for symbols before reading files. Returns ranked hits plus suggested narrow read_file windows.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Root dir. Defaults to ".".' },
        glob: { type: 'string', description: 'Filename glob, e.g. "*.ts".' },
        context_lines: {
          type: 'number',
          description: 'Context lines around each hit. Defaults 2; max 8.'
        },
        max_results: {
          type: 'number',
          description: 'Max hits to return. Defaults 1000.'
        },
        regex: {
          type: 'boolean',
          description: 'Use regex matching.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'run_command',
    description:
      'Last-resort shell escape hatch for explicit command-line tasks; returns combined stdout/stderr output after the command exits.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute.'
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in ms. Clamped 250ms-10min. Default 600000ms.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory (defaults to workspace root).'
        }
      },
      required: ['command']
    }
  }
]
