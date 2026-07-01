# Fast Mode Checklist

Use this during live browser work when speed matters more than exhaustive narration.

## Start

- Orient once with `read_page` or `grep_page`
- Identify the next 2 to 4 actions before touching the page
- Prefer semantic tools first: `set_field`, `submit`, `open_result`
- Keep screenshots as a last resort

## Trust by default

- Known URL navigation
- Unique, clearly labeled button clicks
- Plain text field entry
- Repeating a control pattern that already worked in the same product
- Known left-nav or settings paths already confirmed once

## Light verification only

- Form submitted
- Filter changed
- Rename landed
- Project created
- Dialog opened
- View or tab switched inside the same app

Preferred proof:

- Action return state
- `grep_page` exact text

## Full verification required

- Account identity
- Email verification
- Upload or import completion
- Invite or permission state
- Billing, trial, downgrade, or cancellation
- Anything that can charge money or send email
- New-tab, popup, OAuth, or modal-heavy flows

Preferred proof:

- `grep_page` exact text
- `read_page` if broader orientation is needed
- `read_a11y` for ambiguous controls

## Escalation ladder

1. `grep_page`
2. `read_a11y`
3. `diagnose_target`
4. `screenshot`

Do not skip straight to screenshots unless the UI is genuinely vision-only.

## Avoid

- Full page reads after every click
- Screenshot-confirming ordinary text
- Re-discovering controls that already proved reliable
- Heavy verification on reversible low-risk steps

## Reuse on repeat runs

- Signup path
- Onboarding branch
- Settings or billing route
- Naming conventions
- Which controls are real versus decorative
- Which steps open modals or new tabs

## Rule of thumb

Trust actions. Verify outcomes. Escalate only on ambiguity.
