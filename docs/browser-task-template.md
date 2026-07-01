# Browser Task Template

Use this at the start of a live browser task when you want fast-mode execution without losing reliability. Fill in the blanks, keep it short, and update only at meaningful checkpoints.

## Task

- Goal:
- Visible starting page:
- Success object:
- Risky steps:

## Done means

- [ ] The specific end state exists in the product
- [ ] The highest-risk action was verified from a live source
- [ ] The final account, billing, or permissions state was checked if relevant

Replace these with task-specific checks before starting.

## Plan

1. Orient once on the current page.
2. Take the next 2 to 4 likely actions.
3. Verify only at checkpoints or after unexpected UI behavior.
4. Escalate only if the page stops being trustworthy.

## Trust map

### Trust by default

- Known URL navigation
- Unique labeled button clicks
- Plain text field entry
- Repeating a pattern that already worked in the same product

### Light verification

- Form submit
- Filter change
- Rename
- Internal view switch
- Dialog open

Proof:

- Action return state
- `grep_page` exact text

### Full verification

- Identity or account creation
- Email verification
- Upload or import completion
- Invite or permission state
- Billing, trial, downgrade, or cancellation
- New-tab, popup, OAuth, or modal-heavy steps

Proof:

- `grep_page` exact text
- `read_page` when broader orientation is needed
- `read_a11y` when controls are ambiguous

## Tool order

1. `navigate`
2. `grep_page`
3. `set_field`, `submit`, `open_result`
4. `act`
5. `read_a11y`
6. `diagnose_target`
7. `screenshot`

## Working log

- Current step:
- Last verified checkpoint:
- Deviation seen:
- Next action:

Keep this to one or two lines while the task is active.

## Escalation ladder

1. `grep_page`
2. `read_a11y`
3. `diagnose_target`
4. `screenshot`

Do not jump to screenshots unless the UI is genuinely vision-only.

## Stop doing

- Full page reads after every click
- Screenshot-confirming ordinary text
- Re-discovering controls that already proved reliable
- Heavy verification on reversible low-risk steps

## Closeout

- Final state:
- Where the critical settings were found:
- What was reused successfully:
- What should be trusted next time:
