---
name: cdp-browser-automation
description: Best practices and safety guidelines for driving Gladdis's embedded Chromium browser via Chrome DevTools Protocol (CDP).
requirements: puppeteer-core, chrome-remote-interface
---

# CDP-Based Browser Driving and Verification Skill

This skill defines the patterns for safely and reliably driving the active browser tabs in Gladdis using the Chrome DevTools Protocol (CDP).

## Core Principles

1. **Visual Verification (Screenshot-Guided Loops)**
   - Always take viewport or full-page screenshots to visually verify actions (clicks, navigation, typing).
   - Do not assume an action succeeded just because the CDP command resolved without an error.
   - Wait for animations or network idle after clicking before taking a verification screenshot.

2. **Precise Coordinate Actions**
   - Use the `read_page` or equivalent DOM parser to get exact viewport coordinates `(x, y)` for target elements.
   - When clicking, always target the center of the element's bounding box.
   - For responsive pages, re-evaluate coordinates after resizing or scrolling.

3. **Safe Navigation**
   - Ensure you handle navigation events and wait for the `load` or `networkIdle` events before reading the page DOM.
   - Implement timeouts (e.g., 10-15s) on navigations to avoid hanging the agent loop on slow networks.

4. **Surgical JavaScript Execution**
   - Prefer surgical DOM queries via `execute_in_browser` or `Runtime.evaluate` instead of downloading massive page HTML.
   - Return clean, primitive JSON objects or specific scalar values from JavaScript execution rather than complex circular structures.

5. **Tab & Session Management**
   - Keep track of active tab IDs in the `TabManager`.
   - Clean up attached CDP sessions immediately when a tab is closed to prevent memory leaks.
