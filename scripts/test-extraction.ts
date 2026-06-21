import { readFileSync, writeFileSync } from 'fs'
import { briefPageForSearch } from '../src/main/models/searchBrief'
import type { PageCapture } from '../shared/types'

// This is a minimal PageCapture built from the current tab read_page
const capture: PageCapture = {
  url: 'https://liviaerxin.github.io/blog/llm-assisted-web-scraping-architecture',
  title: 'Engineering LLM-Assisted Web Scraping: From Agentic Discovery to Deterministic Extraction | Frank\' Wiki',
  content: {
    text: `The most robust scraping architecture uses an LLM Agent for the "Discovery Phase" to map endpoints, but relies on deterministic scripts for the actual data extraction.

## The Problem

User's Messy Thought: Use an LLM agent (via MCP tools) to either reverse engineer a web page to write a scraping script, or agentically control a browser to scroll, intercept network endpoints, and save data iteratively.

## Possible Approaches

Based on industry standards, there are three primary architectural approaches to solve this.

### Approach 1: Agent-Assisted Reverse Engineering & Code Generation (The "Script Builder")

- How it works: The LLM agent acts as a developer. Using an MCP tool hooked into Playwright/Puppeteer, it navigates to the page and dumps the network logs (HAR file or XHR requests) after an initial scroll. The agent analyzes the network traffic, identifies the backend GraphQL/REST API returning the comments (in JSON format), and figures out the pagination mechanism (e.g., cursor tokens, page offsets). The agent then writes a standalone, deterministic Python or Node.js script that queries the API directly, bypassing the browser entirely.

- Execution Phase: You run the generated script directly. The LLM is out of the loop.

### Approach 2: Interactive Browser Automation with Network Interception (The "Scrolling Listener")

- How it works: The LLM agent actively controls a headless browser session. An MCP tool exposes browser actions (scroll_down(), wait()) and a network listener (get_intercepted_json()). The browser is configured to intercept and capture all responses matching a specific pattern (e.g., *api/v1/comments*).

- Execution Phase: The agent operates in a continuous loop: command a scroll → the website's JS triggers the API → the MCP tool captures the raw JSON response → the agent saves the data → repeat until no more comments load.

### Approach 3: DOM-Parsing Autonomous Agent (The "Human-Like Browser")

- How it works: The agent does not look at network traffic at all. Instead, it relies on an Accessibility Tree (A11y), DOM snapshots, or Vision (screenshots) via MCP.

- Execution Phase: The agent looks at the page, reads the text of the loaded comments, parses them into a JSON structure via prompt extraction, commands the browser to scroll down, waits for rendering, looks at the new DOM, deduplicates against old comments, and repeats.`,
    markdown: `The most robust scraping architecture uses an LLM Agent for the "Discovery Phase" to map endpoints, but relies on deterministic scripts for the actual data extraction.

## The Problem

...`,
    headings: [
      { level: 2, text: 'The Problem' },
      { level: 2, text: 'Possible Approaches' },
      { level: 3, text: 'Approach 1: Agent-Assisted Reverse Engineering & Code Generation (The "Script Builder")' },
      { level: 3, text: 'Approach 2: Interactive Browser Automation with Network Interception (The "Scrolling Listener")' },
      { level: 3, text: 'Approach 3: DOM-Parsing Autonomous Agent (The "Human-Like Browser")' },
    ]
  },
  data: {
    openGraph: {
      description: 'A comparative analysis of three architectural approaches for automated web scraping using LLM agents and MCP tools'
    },
    meta: {
      description: 'A comparative analysis of three architectural approaches for automated web scraping using LLM agents and MCP tools'
    }
  }
}

const brief = briefPageForSearch(capture, {
  query: 'How can I make LLM-based web scraping more deterministic and reliable?',
  maxChars: 900
})

const output = `# Extraction Test v3 (Natural Language Query)

**Test Query:** "How can I make LLM-based web scraping more deterministic and reliable?"
**Date:** ${new Date().toISOString().split('T')[0]}
**Extractor Logic:** briefPageForSearch with heading-bounded windows (max 480 chars for high-score blocks)

---

${brief}

---

*Generated using updated selectQueryExcerpts heading-window logic*
`

writeFileSync('test-extraction-result-v3.md', output)
console.log('Saved test-extraction-result-v3.md')
console.log('Length:', brief.length)