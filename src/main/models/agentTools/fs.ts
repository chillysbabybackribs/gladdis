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
      'Read a UTF-8 file from the local filesystem. Small files return whole by default; ' +
      'large files return a bounded preview with total-line metadata. For unknown code, ' +
      'use search_files first, then read the exact start_line / end_line range around hits. ' +
      'Pass full: true only when the entire file is genuinely needed. Large outputs are capped.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'number', description: 'First line (1-based).' },
        end_line: { type: 'number', description: 'Last line (inclusive).' },
        full: { type: 'boolean', description: 'Return the whole file up to the hard cap.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description:
      'Create or completely overwrite a file. Parent dirs are created automatically. ' +
      'Prefer edit_file for surgical changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'Full file contents.' }
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
      'Ripgrep-backed recursive search before reading unknown files. Fixed-string queries use ' +
      'smart-case matching and also surface strong file-path/name hits alongside content hits; ' +
      'set regex: true for patterns. Returns ranked hits, compact context, and a suggested ' +
      'read_file follow-up. Skips node_modules/.git/build. Optional glob filter (e.g. "*.ts").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Root dir to search. Defaults to ".".' },
        glob: { type: 'string', description: 'File-name glob, e.g. "*.ts".' },
        context_lines: {
          type: 'number',
          description: 'Nearby lines to include around each hit. Defaults to 2; max 8.'
        },
        max_results: {
          type: 'number',
          description: 'Maximum hits to return. Defaults to 1000; use smaller values for broad queries.'
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as a regular expression instead of a fixed substring.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'run_validation',
    description:
      'Run a fixed project validation command after code edits. ' +
      'Use typecheck for most TypeScript changes, test for behavioral changes, build for packaging/runtime confidence, ' +
      'or check for the full local gate. Do not claim code edits are complete until relevant validation passes.',
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
      'Read the current OS clipboard text (CLIPBOARD selection by default). ' +
      'Use this to inspect what is in the clipboard before copying code, error text, or task notes.',
    parameters: {
      type: 'object',
      properties: {
        selection: {
          type: 'string',
          enum: ['clipboard', 'primary'],
          description: 'Clipboard selection to read. Defaults to "clipboard".'
        }
      }
    }
  },
  {
    name: 'write_clipboard',
    description:
      'Write plain text to the OS clipboard. This is the preferred way to copy model outputs so you can paste them elsewhere. ' +
      'For large text, pass it in full; output is truncated only in tool display.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to place on the clipboard.' },
        selection: {
          type: 'string',
          enum: ['clipboard', 'primary'],
          description: 'Clipboard selection to write. Defaults to "clipboard".'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'publish_changes',
    description:
      'Commit and push local repository changes after successful code edits and validation. ' +
      'Stages changes according to .gitignore, creates one commit, and pushes the current branch to the configured Git remote. ' +
      'Use this automatically at the end of coding tasks when validation has passed, unless the user explicitly says not to push.',
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
      'Run an arbitrary shell command on the local machine and return its combined stdout/stderr. ' +
      'Use this to install or update whatever the task needs — packages (npm/pnpm/pip/apt-get/brew), ' +
      'repos (git clone), CLIs, or any other tool — and to run build/setup steps that run_validation does not cover. ' +
      'The command runs as the current OS user with full access; there is no approval prompt. ' +
      'For system packages that need root (e.g. apt-get/dpkg), prefix the command with "sudo" — passwordless sudo is configured, so "sudo apt-get install -y <pkg>" runs unattended. ' +
      'Prefer run_validation for the fixed typecheck/test/build checks; use this for everything else. ' +
      'Note: a small high-signal denylist (rm -rf /, dd of=/dev/sd*, fork bombs, …) is enforced by default; see the README "Threat model" section for the env overrides.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The full shell command line to execute, e.g. "npm install -g pnpm" or "git clone <url>".'
        },
        timeout_ms: {
          type: 'number',
          description: 'Command timeout in milliseconds. Clamped to 250ms-10min. Defaults to 600000ms.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory. Defaults to the workspace root.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'audit_codebase',
    description:
      'Runs a Google Gemini sub-agent to audit the codebase. It parses the file tree, package.json, ' +
      'and major configs to return a rich markdown map of the technology stack, module architecture, ' +
      'core entry points, schemas, and guidelines. Defaults to a fast/cheap model with automatic ' +
      'fallback if it has been retired; pass `model` to pin a specific Google model. ' +
      'Call this first to understand the workspace layout.',
    parameters: {
      type: 'object',
      properties: {
        focusPath: {
          type: 'string',
          description: 'Optional folder or file path to focus the audit on (e.g. "src/renderer").'
        },
        model: {
          type: 'string',
          description:
            'Optional Google model id override (e.g. "gemini-2.5-pro"). If unset, uses the audit fallback chain.'
        }
      }
    }
  }
]
