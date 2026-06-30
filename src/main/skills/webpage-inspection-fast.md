---
name: webpage-inspection-fast
description: Land on a live webpage, verify it visually, and extract network, DOM-visible, and accessibility-tree evidence with the shortest trustworthy Gladdis workflow.
---

Use this skill when the job is to inspect a live webpage quickly and come back with evidence, not guesses.

## Core model
Treat the page as three complementary surfaces:
- a rendered UI that needs visual confirmation
- an accessibility tree that exposes controls and labels
- a network-backed data source that often holds the cleanest truth

## Tool priority
1. `watch_network` — arm before the page-changing action so the useful requests are captured at the right moment
2. `navigate` or `fetch_page` — open the page depending on whether interaction is required
3. `screenshot` — verify the page actually rendered and is not blank, blocked, or mid-transition
4. `read_page` — fast orientation for visible content, headings, links, and action targets
5. `read_a11y` — primary control map for buttons, fields, menus, and stable refs
6. `execute_in_browser` — surgical DOM extraction for a few exact facts when the page digest is too broad

## Default workflow
1. Arm network capture
   - Use `watch_network` in `next_action` mode
   - Filter by URL substring and resource types such as `document`, `fetch`, and `xhr`
   - Add `script` only if the page stores useful config there
2. Open the target
   - Use `navigate` when you know the URL
   - Use `fetch_page` when you only need to read and do not need to interact
3. Verify visually
   - Take a `screenshot`
   - If the page is blank, blocked by a modal, or still animating, do not conclude yet
4. Read the rendered page
   - Use `read_page` with a focused prompt
   - Prefer `viewportOnly: true` on the first pass for speed
5. Read the a11y tree
   - Use `read_a11y` for labels, roles, states, and refs like `@a1`
   - Set `interactiveOnly: false` when non-interactive structure matters too
6. Pull surgical DOM facts
   - Use `execute_in_browser` to return a compact JSON object
   - Extract exact fields such as the title, `h1`, hero controls, nav labels, or one specific selector

## Operating rules
- Perceive before acting
- Do not assume navigation success means usable page state
- Prefer a small, focused DOM read over dumping large HTML
- Prefer network bodies over text scraping when the page is data-heavy
- Re-read after any interaction that changes content or control state
- Keep sensitive network values redacted unless the task explicitly requires them

## Output shape
Summaries built with this skill should include:
- URL and title
- one visual verification note
- key rendered-content findings
- key a11y/control findings
- key network findings, including relevant endpoints or response bodies

## Example
`namecheap.com` worked well with this exact sequence:
1. Arm `watch_network` with a `namecheap` URL filter
2. `navigate` to `https://www.namecheap.com/`
3. Take a `screenshot` to verify the hero search UI rendered
4. Use `read_page` to capture the hero heading and top actions
5. Use `read_a11y` to capture the search controls and stable refs
6. Use `execute_in_browser` to extract a compact JSON summary of title, `h1`, nav labels, and hero controls
