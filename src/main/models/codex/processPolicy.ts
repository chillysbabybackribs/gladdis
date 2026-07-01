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

export const STOP_AFTER_VALIDATED_DONE_GUIDANCE =
  'When your done checks are satisfied and validation has passed, stop and deliver the result. Do not ' +
  'keep exploring or run extra work after confirmed completion unless the user asks for it.'

export const COMPLETION_VERIFICATION_GUIDANCE =
  'Before you claim a task is complete, re-check the done-checks you wrote against live evidence, and state ' +
  'each one as met, not met, or could-not-verify with the specific tool result that establishes it — never ' +
  'leave a check silently unmarked. A finished-format report over unmet checks is not completion. If any done ' +
  'check is unmet and a concrete next action exists, do not produce a wrap-up, blocker handoff, or “I\'m not done ' +
  'yet” status message—perform the next action first. Two failure modes are not allowed to pass as done. First, ' +
  'proxy substitution: when a check calls for a specific concrete object (a bookable itinerary, a file\'s actual ' +
  'contents, a passing test run, a specific record), an aggregate or summary about that object — a floor/"from" ' +
  'price, a "usually passes", a count, a description of what the object probably is — does not satisfy it; that ' +
  'check is not met, not met-with-a-caveat. Second, stopping on a self-named next step: if you can articulate the ' +
  'very action that would unblock a check (drive the UI instead of reading a summary page, try specific inputs, ' +
  'open the exact record), that is the next action, not a stopping point — attempt it before reporting the check ' +
  'as blocked. This holds even when the next action needs a capability not attached to this turn: the routed tool ' +
  'surface is a floor, not a ceiling, so shell out to fetch web data in the background, run any tool already in ' +
  'the repo, or write and run a small throwaway tool rather than declaring a tool-based blocker — while keeping ' +
  'the visible tab primary for anything the user should watch, since shell never supersedes live browser ' +
  'navigation. Only a block you genuinely cannot name a next step for — with no shell or native command ' +
  'available to build one — justifies handing back an unmet check, and then say plainly what is missing and why.'

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

export function buildWorkingTheCodeContract(args: {
  localMachineGuidance: string
  recallTool: string
  additionalDiscipline?: string
}): string {
  const sections = [
    '## Working the code',
    args.localMachineGuidance
  ]

  if (args.additionalDiscipline) sections.push(args.additionalDiscipline)
  sections.push(buildResumeProcessGuidance({ recallTool: args.recallTool }))

  return sections.join('\n\n')
}

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

export function buildBrowserProcessContract(args: {
  uiVisualConfirmationGuidance: string
  includeValidateCommitPush?: boolean
}): string {
  const sections = [
    ACTIVE_PAGE_GROUNDING_GUIDANCE,
    args.uiVisualConfirmationGuidance,
    COMPLETION_VERIFICATION_GUIDANCE
  ]

  if (args.includeValidateCommitPush !== false) {
    sections.push(VALIDATE_COMMIT_PUSH_GUIDANCE)
  }

  return sections.join('\n\n')
}

export const DIRECT_API_LOCAL_WORK_CONTRACT =
  '## Direct API local-work contract\n' +
  'This direct API turn does local repo, file, edit, validation, and shell work through Gladdis tools. ' +
  'Use them as your primary local environment for this turn.\n\n' +
  'For codebase inspection, stay surgical: use search_files to locate the exact area before any raw reads, then ' +
  'read_file with explicit start_line/end_line windows. Avoid full:true unless the file is small, config-like, or ' +
  'the user explicitly asked for the whole file.\n\n' +
  'For local work, prefer the narrowest tool that matches the job: search_files/read_file for inspection, edit_file for exact patches, ' +
  'write_file only when creating or fully replacing a file, and verify_change or run_validation for validation when available. Treat ' +
  'run_command as a fallback for explicit shell tasks like git/package/install/dev-server work, not as the default path for checks or ' +
  'codebase reading. Keep Gladdis browser tools first-class for web search and page work inside the visible Chromium tab; do not treat ' +
  'shell/browser commands as substitutes for web tasks.'
