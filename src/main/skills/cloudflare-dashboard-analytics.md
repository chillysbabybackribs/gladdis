---
name: cloudflare-dashboard-analytics
description: Navigate Cloudflare-style analytics and admin dashboards using a11y-first control discovery, network-first data extraction, and targeted page confirmation.
---

Use this skill for Cloudflare dashboards and similar React/admin analytics UIs where controls are accessible but chart/card data is noisy in raw page text.

## Core model
Treat the page as:
- a control-rich SPA for navigation
- a network-backed data surface for truth
- a noisy text surface for confirmation only

## Tool priority
1. `read_a11y` — primary tool for finding tabs, comboboxes, buttons, filters, sidebar items, and selected state
2. `act` with `@aN` refs — primary interaction path after `read_a11y`
3. `watch_network` — primary source for exact chart/table metrics, breakdowns, and refreshed analytics data
4. `grep_page` — targeted confirmation for specific headings, labels, rows, or phrases
5. `read_page` — orientation only when you do not yet know what section you are on
6. `execute_in_browser` — fallback for extracting one stubborn widget or DOM region when a11y and network are insufficient

## Default workflow
1. Orient
   - Use `read_page` only to confirm the current screen or page heading
   - Do not use it as the main extraction tool for metrics
2. Build a control map with `read_a11y`
   - Query for specific controls and concepts, not broad topics
   - Good focus terms:
     - `time period`
     - `requests`
     - `bandwidth`
     - `unique visitors`
     - `attacks blocked`
     - `cache`
     - `top traffic countries`
3. Interact one change at a time
   - Click one tab/filter only
   - Re-read after each action
4. Choose the right truth source
   - For controls/state: `read_a11y`
   - For visible labels/headings/rows: `grep_page`
   - For chart values and table payloads: `watch_network`
5. Verify before concluding
   - Confirm important findings with at least two signals when possible
   - Example: selected tab in a11y + matching heading in page text, or visible card + matching network payload

## Exact operating rules
- Perceive before acting
- Never rely on a full-page text scrape as the primary dashboard reader
- Prefer focused `read_a11y` prompts over broad ones like `analytics` or `traffic`
- After `read_a11y`, prefer `act(ref)` using the returned `@aN` refs
- Re-read after every navigation, tab switch, filter change, or expand/collapse action
- If a chart/table appears visually but text extraction is poor, arm `watch_network` before changing the control that refreshes it
- Use `grep_page` with distinctive phrases, not single generic keywords
- Use `execute_in_browser` only as a surgical fallback, not as the default path

## What each tool is best for
### `read_a11y`
Use for:
- tabs
- date/time filters
- sidebar navigation
- buttons and dropdowns
- selected state
- references like `@a46`

Best practice:
- Ask for the specific control family on screen
- Example prompts:
  - `time period requests bandwidth unique visitors`
  - `attacks blocked waf firewall bot`
  - `cache bytes saved hit rate`

### `act` / `grep_click`
Use for:
- deterministic clicks after control discovery
- cases where labels are duplicated and the a11y ref is safer

Best practice:
- If you have a ref, use it
- Change one thing, then re-read

### `watch_network`
Use for:
- exact counts behind charts/cards
- top lists and breakdowns
- XHR/fetch/GraphQL-backed analytics refreshes

Best practice:
- Start capture before the interaction that refreshes the widget
- Trigger one tab/filter change
- Read the smallest relevant response set

### `grep_page`
Use for:
- confirming a heading
- locating a specific phrase
- reading a known table row or nearby section text

Best practice:
- Search for full phrases such as:
  - `Previous 24 hours`
  - `Top Traffic Countries / Regions`
  - `Country / Region`
- Avoid broad one-word queries on dashboards

### `read_page`
Use for:
- title
- main heading
- broad orientation

Do not use for:
- extracting dashboard metrics precisely
- reading dense analytics cards

### `execute_in_browser`
Use for:
- one custom DOM read when the page is visible but not well exposed to a11y or page grep

Do not use for:
- ordinary discovery
- coordinate finding
- replacing `read_a11y` or `watch_network`

## Cloudflare-specific navigation process
### HTTP / Traffic Analytics
1. `read_page` to confirm you are on the traffic analytics screen
2. `read_a11y` for `time period requests bandwidth unique visitors`
3. Click the needed tab or date control
4. Re-run `read_a11y` to confirm selected state
5. Use `grep_page` for a nearby distinctive heading or label
6. If exact chart numbers matter, use `watch_network` during the tab/date change

### Security Analytics
1. `read_a11y` for `attacks blocked firewall waf bot security`
2. Click one filter or section only
3. Confirm with `grep_page` on a visible section title
4. Use `watch_network` for event counts, mitigations, or breakdowns

### Cache / Performance pages
1. `read_a11y` for `cache bytes saved hit rate bandwidth optimization`
2. Navigate via labeled controls
3. Confirm the visible section with `grep_page`
4. Prefer network data or clearly labeled cards over broad text extraction

## Decision tree
- If the question is “where do I click?” → `read_a11y`
- If the question is “what visible label/heading/row is shown?” → `grep_page`
- If the question is “what exact numbers power this chart?” → `watch_network`
- If the question is “am I on the right screen?” → `read_page`
- If the question is “why can’t I extract this one widget?” → `execute_in_browser`

## Anti-patterns to avoid
- Dumping the whole page with text extraction and treating it as authoritative
- Searching generic words like `traffic`, `requests`, or `cache` on a large dashboard
- Clicking multiple controls before re-reading
- Trusting a single extraction path for an important conclusion
- Using DOM scripting first when the page already exposes labeled controls

## Minimal loop to follow every time
1. Orient briefly
2. Discover controls with `read_a11y`
3. Click one thing
4. Re-read state
5. Capture network if data changed
6. Confirm with targeted page text
7. Summarize findings and confidence

## Output style when using this skill
When reporting findings from a Cloudflare dashboard:
- state the selected scope/time period
- separate visible UI facts from inferred meaning
- call out whether the conclusion came from a11y, visible text, or network data
- note uncertainty if the page surface is noisy and a second signal was not available
