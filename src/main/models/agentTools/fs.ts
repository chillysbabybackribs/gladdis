import type { ToolDef } from '../browserTools'

/**
 * FS — local filesystem + clipboard + shell + publish + audit_codebase.
 * Anything that touches the OS user's local environment lives here, except
 * the repo-intel tools (REPO_TOOLS) which go through the CapabilityBroker.
 */
export const FS_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 file with optional line bounds. Prefer repo_overview/search_repo/repo_grep_task/search_files first, then use read_spans or line-bounded reads as follow-up; ' +
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
    name: 'run_validation',
    description:
      'Compatibility alias. Prefer verify_change where possible.',
    parameters: {
      type: 'object',
      properties: {
        check: {
          type: 'string',
          enum: ['typecheck', 'test', 'build', 'check'],
          description: 'Validation command to run: typecheck, test, build, or check.'
        }
      },
      required: ['check']
    }
  },
  {
    name: 'read_clipboard',
    description:
      'Read OS clipboard text.',
    parameters: {
      type: 'object',
      properties: {
        selection: {
          type: 'string',
          enum: ['clipboard', 'primary'],
          description: 'Selection to read. Defaults to "clipboard".'
        }
      }
    }
  },
  {
    name: 'write_clipboard',
    description:
      'Write plain text to the OS clipboard.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Clipboard text.' },
        selection: {
          type: 'string',
          enum: ['clipboard', 'primary'],
          description: 'Selection to write. Defaults to "clipboard".'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'publish_changes',
    description:
      'Commit and push local changes after validation.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Short commit message. Defaults to "Update Gladdis app".'
        },
        remote: {
          type: 'string',
          description: 'Git remote to push. Defaults to origin.'
        },
        branch: {
          type: 'string',
          description: 'Branch to push. Defaults to the current branch.'
        }
      }
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command and return combined stdout/stderr output.',
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
  },
  {
    name: 'audit_codebase',
    description:
      'Run only on explicit audit requests. Pass the user’s audit objective in "goal" so the report shape follows the request instead of a fixed template.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The specific audit objective to answer, ideally preserving the user request.'
        },
        focusPath: {
          type: 'string',
          description: 'Optional folder/file path to focus the audit.'
        },
        model: {
          type: 'string',
          description:
            'Optional model override (e.g. "gemini-2.5-pro").'
        }
      }
    }
  },
  {
    name: 'launch_web_dev_server',
    description:
      'Launch and monitor a local dev/preview server.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: "start", "stop", "status", or "restart".',
          enum: ['start', 'stop', 'status', 'restart']
        },
        command: {
          type: 'string',
          description: 'Server command (e.g. npm run dev). Auto-detect if omitted.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the server command.'
        },
        port: {
          type: 'number',
          description: 'Expected port to wait on.'
        },
        url: {
          type: 'string',
          description: 'Expected URL/health endpoint to poll.'
        },
        open_browser: {
          type: 'boolean',
          description: 'Open ready URL in a new tab when true.'
        },
        timeout_ms: {
          type: 'number',
          description: 'Milliseconds to wait for readiness.'
        }
      }
    }
  }
]
