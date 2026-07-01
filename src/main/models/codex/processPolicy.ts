export const WORK_FROM_REAL_CODEBASE_GUIDANCE =
  'Use the actual workspace on disk, verify before asserting, and complete the task end-to-end when feasible. ' +
  'Before changing anything, search/read the relevant files and run the build/tests so edits land on the real ' +
  'codebase, not assumptions. Install missing local packages or tools directly when needed.'

export const STOP_WHEN_DONE_GUIDANCE =
  'Once the requested task is confirmed complete, stop and deliver the result instead of continuing by default.'

export const VALIDATE_COMMIT_PUSH_GUIDANCE =
  'After coding edits, validate, then commit and push to origin automatically unless the user explicitly says not to push.'

export const ACTIVE_PAGE_GROUNDING_GUIDANCE =
  'If the request includes an `[Active page: ...]` preamble about page content, a link, story, title, ' +
  'or current-site state, ground the answer with grep_page or read_a11y first.'

export const UI_VISUAL_CONFIRMATION_GUIDANCE =
  'For UI/frontend/dev-server work, completion requires visual confirmation: after editing UI and launching ' +
  'the local dev server, use the attached Gladdis browser tools to confirm the page is not blank and the ' +
  'intended UI is visible before finishing.'

export const CODEX_UI_VISUAL_CONFIRMATION_GUIDANCE =
  'For UI/frontend/dev-server work, completion requires visual confirmation: after editing UI and ' +
  'launching the local dev server, open the rendered page and confirm with grep_page and/or read_a11y ' +
  '(or screenshot if the UI is genuinely vision-only) that it is not blank and the intended UI is ' +
  'visible before answering. Do not stop at build/curl-only validation for UI work.'

export function buildCodexLocalMachineGuidance(): string {
  return (
    'This turn has the local machine under it. Before changing anything, locate the truth of how this ' +
    'repo actually works — search and read the relevant files, run the build/tests to see current ' +
    'state — so edits land on the real codebase instead of an assumed one. Use your native shell/file ' +
    'tools for repo, file, and shell work. The desktop user has passwordless sudo, so install whatever ' +
    'a task needs yourself — language packages, repos, or system packages via `sudo apt-get install ' +
    '-y` — instead of reporting a tool as missing.'
  )
}

export function buildClaudeLocalMachineGuidance(): string {
  return (
    'This turn runs through a logged-in local Claude Code CLI session. Gladdis launches Claude Code with ' +
    '`--dangerously-skip-permissions`, so local repo, file, shell, git, commit, and push actions are already ' +
    'unrestricted. Do not stop for Claude permission or approval workflows, and do not ask the user to manually ' +
    'run local commands just to bypass a Claude-side restriction unless a command actually fails.'
  )
}

export function buildCursorLocalMachineGuidance(): string {
  return (
    'This turn runs through a logged-in local Cursor Agent CLI session. Use the actual workspace on disk, ' +
    `verify before asserting, and complete the task end-to-end when feasible. ${STOP_WHEN_DONE_GUIDANCE}`
  )
}

export const CLAUDE_NATIVE_WORK_GUIDANCE =
  'Keep Claude Code native local repo, file, shell, git, and validation abilities focused on the task.'

export const CURSOR_NATIVE_WORK_GUIDANCE =
  'Use Cursor native local repo, file, shell, and validation abilities for code work.'

export const CURSOR_NATIVE_VERIFICATION_GUIDANCE =
  'After editing files, run the narrowest relevant local verification command before claiming success. ' +
  'If validation fails, fix it or say clearly why it cannot pass.'

export const CURSOR_POST_ACTION_REPAIR_GUIDANCE =
  'If Gladdis feeds back a failed post-action verification result, treat that as actionable repair context, ' +
  'continue from the same workspace state, and do another validation pass before finishing.'

export const CURSOR_FINISH_AFTER_VALIDATION_GUIDANCE =
  'Once validation passes and the requested task is complete, stop and deliver the result instead of continuing by default.'

export function buildCursorNativeWorkContract(args?: { includeBrowserWorkLine?: boolean }): string {
  const segments = [
    CURSOR_NATIVE_WORK_GUIDANCE,
    CURSOR_NATIVE_VERIFICATION_GUIDANCE,
    CURSOR_POST_ACTION_REPAIR_GUIDANCE,
    CURSOR_FINISH_AFTER_VALIDATION_GUIDANCE
  ]

  if (args?.includeBrowserWorkLine) {
    segments.push('Use the attached Gladdis MCP tools for browser work.')
  }

  return segments.join(' ')
}

export function buildResumeProcessGuidance(args: { recallTool: string }): string {
  return (
    'Resume process: when the user only asks to resume, pick up, or find where the prior chat left off, ' +
    `call ${args.recallTool}, summarize the relevant saved chat context, and stop for the next concrete ` +
    'instruction. Do not edit files, run validations, navigate pages, or continue old work from a bare ' +
    'resume request.'
  )
}
