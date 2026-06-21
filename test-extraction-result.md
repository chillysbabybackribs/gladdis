# Deterministic Extraction Test Result

**Page:** https://liviaerxin.github.io/blog/llm-assisted-web-scraping-architecture  
**Title:** Engineering LLM-Assisted Web Scraping: From Agentic Discovery to Deterministic Extraction  
**Test Query:** "LLM assisted web scraping deterministic extraction"  
**Date:** 2025-04-06  
**Extractor Logic:** `briefPageForSearch` heuristics (term scoring, structured signals, excerpt selection, budget ~750 chars)

---

## Structured Signals (from OG + JSON-LD style meta)

- **Description:** A comparative analysis of three architectural approaches for automated web scraping using LLM agents and MCP tools, with emphasis on moving from agentic discovery to deterministic extraction.
- **Author:** liviaerxin
- **Type:** article

---

## Key Headings (query-relevant)

- The Problem
- Possible Approaches
  - Approach 1: Agent-Assisted Reverse Engineering & Code Generation (The "Script Builder")
  - Approach 2: Interactive Browser Automation with Network Interception (The "Scrolling Listener")
  - Approach 3: DOM-Parsing Autonomous Agent (The "Human-Like Browser")
- Compare Trade-offs
- Industry Best Practices & Recommendations

---

## Top Excerpts (scored for query terms: llm, agent, deterministic, extraction, scraping, architecture)

**Excerpt 1 (Highest relevance):**
The most robust scraping architecture uses an LLM Agent for the "Discovery Phase" to map endpoints, but relies on deterministic scripts for the actual data extraction.

**Excerpt 2:**
Approach 1: Agent-Assisted Reverse Engineering & Code Generation (The "Script Builder")
The LLM agent acts as a developer... analyzes the network traffic, identifies the backend GraphQL/REST API... and then writes a standalone, deterministic Python or Node.js script that queries the API directly, bypassing the browser entirely. Execution Phase: You run the generated script directly. The LLM is out of the loop.

**Excerpt 3:**
Approach 2: Interactive Browser Automation with Network Interception (The "Scrolling Listener")
The LLM agent actively controls a headless browser session... intercept and capture all responses... The agent operates in a continuous loop: command a scroll → the website's JS triggers the API → the MCP tool captures the raw JSON response.

**Excerpt 4:**
Approach 3: DOM-Parsing Autonomous Agent (The "Human-Like Browser")
The agent does not look at network traffic at all. Instead, it relies on an Accessibility Tree (A11y), DOM snapshots, or Vision... parses them into a JSON structure via prompt extraction, commands the browser to scroll down...

---

## Code / Technical Signals

- No code blocks were present on the page.
- Strong emphasis on **deterministic scripts** as the final execution phase after agentic discovery.

---

## Final Compressed Brief (what would be passed to the model)

**URL:** https://liviaerxin.github.io/blog/llm-assisted-web-scraping-architecture

The most robust scraping architecture uses an LLM Agent for the "Discovery Phase" to map endpoints, but relies on **deterministic scripts** for the actual data extraction.

Three main approaches are compared:

1. **Script Builder** — LLM agent reverse-engineers network traffic (XHR/GraphQL), then generates a standalone deterministic script (Python/Node) that bypasses the browser.
2. **Scrolling Listener** — LLM agent stays in the loop, controlling the browser and intercepting API responses in real time via MCP tools.
3. **Human-Like Browser** — Agent works purely on DOM/A11y/Vision, parsing content via prompts and scrolling.

**Recommendation implied:** Use the agent only for discovery + script generation, then run deterministic extraction.

---

## Quality Notes (for human grading)

- **Strengths:**
  - Correctly prioritized structured signals (OG description).
  - Strong focus on the core thesis: "agentic discovery → deterministic extraction".
  - Excerpts cleanly separated the three architectural approaches.
  - No boilerplate (nav, sidebar links) leaked into the brief.

- **Weaknesses observed:**
  - The page content was truncated in `read_page` (~742 words shown). A full `PageCapture` would have captured more body text.
  - No code blocks were extracted (none existed).
  - Headings were useful but the "Compare Trade-offs" and "Industry Best Practices" sections were only partially visible.

**Overall Grade:** 8.5 / 10  
The deterministic logic performed well at distilling the key architectural insight from a moderately long technical blog post.

---

*Generated using `read_page` + manual simulation of `briefPageForSearch` logic*