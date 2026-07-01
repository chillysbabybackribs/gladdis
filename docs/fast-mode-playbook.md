# Fast Mode Playbook

Quick companion: [Fast Mode Checklist](/home/dp/Desktop/myworkspace/Gladdis/docs/fast-mode-checklist.md)

Fast mode means using the minimum verification needed to stay reliable during live browser work. The goal is not zero checks. The goal is to spend checks only where the UI is likely to stall, branch, ignore input, or open a risky path.

## Core rule

Trust stable mechanics. Verify risky outcomes.

## Trust levels

### Level 1: Trust by default

Use this after one clean read of the page:

- Navigate to a known URL
- Click a unique, clearly labeled button
- Fill a normal text field
- Use a known left-nav or settings path already confirmed once
- Repeat the same action pattern in the same product

### Level 2: Light verification

Use a quick text check instead of a full page re-read:

- Form submission
- Search or filter changes
- Renames
- Project creation
- Share or invite dialogs opening
- Switching tabs or views inside the same app

### Level 3: Full verification

Always verify explicitly:

- Sign-up, login, and account identity
- Email verification
- File upload and import completion
- Billing, trials, downgrades, and cancellation
- Permissions or invites actually landing
- Anything that can charge money or send email
- New-tab flows, popups, OAuth, and modal-heavy UI

## Default tool order

Use the fastest trustworthy tool that fits the step:

1. `navigate` for known URLs
2. `grep_page` for exact labels, status text, and distinctive phrases
3. `set_field`, `submit`, and `open_result` for semantic actions
4. `act` when semantic tools do not fit or the control is custom
5. `read_a11y` when targeting is ambiguous or the component hides the real control
6. `diagnose_target` when an action should have worked but did nothing
7. `screenshot` only for vision-only problems

## Fast mode workflow

1. Orient once at the start with `read_page` or `grep_page`.
2. Move in short trusted bursts such as fill, submit, next.
3. Verify only at checkpoints such as account created, import finished, dashboard visible, invite landed, or cancellation confirmed.
4. If an action works once, reuse the pattern instead of re-discovering the same control type.
5. If the page deviates, escalate one level only: `grep_page` -> `read_a11y` -> `diagnose_target` -> `screenshot`.

## What to stop doing

- Do not run a full page read after every click
- Do not screenshot just to confirm ordinary text
- Do not use accessibility-tree reads for plain text pages
- Do not re-search the DOM for controls already proved
- Do not verify reversible low-risk steps with heavyweight tools

## What to keep verifying

These are never trust-only:

- Email inbox confirmation
- Upload or import success
- Collaborator invite state
- Workspace billing state
- Downgrade or cancel completion
- Final plan status

## Verification ladder

Use the cheapest proof that answers the question:

1. Action return state
2. `grep_page` for exact text
3. `read_page` for broader orientation
4. `read_a11y` for interactive controls
5. `screenshot` for visual-only confirmation

If `grep_page` can prove it, do not screenshot it.

## Product familiarity rule

Once a product has been driven successfully, later runs can reuse:

- The signup route
- The onboarding branch
- The settings or billing path
- Naming conventions
- Which controls are real versus decorative
- Which steps tend to open modals or new tabs

That is where the large speedup comes from on repeat runs.

## Rule of thumb

Trust actions. Verify outcomes. Escalate only on ambiguity.
