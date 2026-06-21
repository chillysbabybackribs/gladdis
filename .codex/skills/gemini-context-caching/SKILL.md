---
name: gemini-context-caching
description: Guidelines and standards for utilizing Gemini's context caching efficiently in Gladdis to minimize latency and token overhead.
requirements: '@google/genai'
---

# Gemini Context Caching & Token Discipline Skill

This skill outlines guidelines and requirements for implementing and managing Gemini's context caching features in the Gladdis codebase, specifically optimized for our active model selection: **Gemini 3.5 Flash** (`gemini-3.5-flash`), **Gemini 2.5 Pro** (`gemini-2.5-pro`), and **Gemini 2.5 Flash** (`gemini-2.5-flash`). Gemini context caching is highly sensitive to input consistency and can drastically improve performance in multi-turn agent loops.

## Core Principles

1. **Deterministic Cache Keys**
   - The cache key is constructed from the exact sequence of `systemInstruction`, `tools`, and `contents` up to the cached point.
   - Any modification to tools or instructions will cause a cache miss and trigger full re-generation of the cache.
   - Standardize system instructions across all turns to ensure high cache hit rates.

2. **No-Overhead Request Configuration**
   - In any loop where a cache is active, **strip** the `systemInstruction` and `tools` parameters from the `generateContent` request config.
   - Google's API throws errors if instructions/tools are supplied alongside an active cache ID, as the model automatically pulls them from the warm cache.

3. **Context Ordering**
   - Place large static content (e.g., codebase files, database schemas, API specs) early in the contents list.
   - Ensure file contents are cached in a stable, alphabetically-sorted or dependency-sorted order to maximize cache reuse across multiple turns.

4. **Minimum Token Threshold**
   - Gemini context caching is only cost-effective and supported for contexts larger than ~32k tokens.
   - Do not attempt caching for small, quick chat conversations. Check token counts before initiating a cache.

5. **Cache Time-To-Live (TTL)**
   - Set a reasonable TTL (e.g., 5 to 10 minutes) for interactive sessions.
   - Implement automatic cache refresh or extension if the user continues the session.
