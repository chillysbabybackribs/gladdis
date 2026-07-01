export const WORK_FROM_REAL_CODEBASE_GUIDANCE =
  'Use the actual workspace on disk, verify before asserting, and complete the task end-to-end when feasible. ' +
  'Before changing anything, search/read the relevant files and run the build/tests so edits land on the real ' +
  'codebase, not assumptions. Install missing local packages or tools directly when needed.'

export const STOP_WHEN_DONE_GUIDANCE =
  'Once the requested task is confirmed complete, stop and deliver the result instead of continuing by default.'

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

export function buildResumeProcessGuidance(args: { recallTool: string }): string {
  return (
    'Resume process: when the user only asks to resume, pick up, or find where the prior chat left off, ' +
    `call ${args.recallTool}, summarize the relevant saved chat context, and stop for the next concrete ` +
    'instruction. Do not edit files, run validations, navigate pages, or continue old work from a bare ' +
    'resume request.'
  )
}

