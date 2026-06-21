/**
 * deepSearch — an advanced, token-efficient Deep Search agent pipeline.
 *
 * It uses Gemini 2.5 Flash-lite once up-front to construct a strategic, multi-query
 * exploration plan, then executes a fully deterministic TypeScript parallel crawling loop
 * using native Chromium background tabs. It harvests links, ranks them by relevance,
 * performs secondary recursive crawls (depth layers), and compiles a highly compressed,
 * high-density markdown dossier of evidence, costing 90%+ fewer LLM tokens than standard multi-turn loops.
 */

import type { TabManager } from '../TabManager'
import type { PageExtractor } from '../extract/PageExtractor'
import type { PageCapture } from '../../../shared/types'
import { briefPageForSearch } from './searchBrief'
import { runHiddenSearch } from './hiddenSearch'
import { GoogleGenAI } from '@google/genai'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface DeepSearchOptions {
  query: string
  depth?: number
  maxPages?: number
  apiKey?: string
  onProgress?: (message: string) => void
}

export interface DeepSearchOutcome {
  ok: boolean
  text: string
  queriesRun: string[]
  sourcesVisited: { url: string; title: string; depth: number }[]
}

interface SearchPlan {
  queries: string[]
  concepts: string[]
  questions: string[]
}

/**
 * Executes deep web search and crawling.
 */
export async function runDeepSearch(
  deps: { tabs: TabManager; extractor: PageExtractor },
  options: DeepSearchOptions
): Promise<DeepSearchOutcome> {
  const query = options.query
  const depth = options.depth ?? 2
  const maxPages = options.maxPages ?? 5
  const onProgress = options.onProgress ?? (() => {})

  onProgress(`Initializing Deep Search for: "${query}"`)

  // 1. Generate Search Strategy Plan (Gemini 2.5 Flash-lite or Fallback)
  let plan: SearchPlan = {
    queries: [query],
    concepts: query.toLowerCase().split(/\W+/).filter(w => w.length > 3),
    questions: [`What are the key facts about: ${query}?`]
  }

  if (options.apiKey) {
    try {
      onProgress('Formulating strategic research plan using Gemini 2.5 Flash-lite...')
      const ai = new GoogleGenAI({ apiKey: options.apiKey })
      const prompt = `You are the Strategic Planner for a Deep Search Agent.
Your goal is to analyze the user's research query and generate a comprehensive search plan to be executed by a deterministic parallel web crawler.

User Research Query: "${query}"

Generate a JSON object containing:
1. "queries": A list of 2 to 3 distinct, highly effective search queries to run on a search engine (DuckDuckGo). They should target different aspects, angles, or sub-topics of the query.
2. "concepts": A list of 4 to 8 focus keywords/concepts (e.g., ["revenue", "acquisition", "Q4 2024"]) to guide relevance scoring and anchor link matching.
3. "questions": A list of 2 to 4 key factual questions this search is trying to resolve.

Respond ONLY with a valid JSON object matching this schema, without markdown blocks or wrappers.`

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      })

      const text = response.text ? response.text.trim() : ''
      if (text) {
        const parsed = JSON.parse(text) as Partial<SearchPlan>
        if (parsed.queries && Array.isArray(parsed.queries) && parsed.queries.length > 0) {
          plan.queries = parsed.queries
        }
        if (parsed.concepts && Array.isArray(parsed.concepts) && parsed.concepts.length > 0) {
          plan.concepts = parsed.concepts.map(c => c.toLowerCase())
        }
        if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
          plan.questions = parsed.questions
        }
        onProgress(`Plan formulated successfully. Concept keywords: ${plan.concepts.join(', ')}`)
      }
    } catch (err: any) {
      onProgress(`Warning: Gemini plan formulation failed (${err.message}). Using robust deterministic fallback.`)
    }
  } else {
    onProgress('No API key provided for planning. Using robust deterministic fallback.')
  }

  // Normalize plan queries & concepts
  const normalizedConcepts = plan.concepts.map(c => c.toLowerCase())
  const visitedUrls = new Set<string>()
  const completedProbes: { url: string; title: string; depth: number; brief: string; wall?: string }[] = []
  const sourcesVisited: { url: string; title: string; depth: number }[] = []

  // 2. LAYER 0: Run search queries in parallel & rank SERPs
  onProgress(`Executing SERP queries in parallel: ${plan.queries.map(q => `"${q}"`).join(', ')}`)
  const serpPromises = plan.queries.map(q =>
    runHiddenSearch(q, 10).catch(err => {
      onProgress(`Search query failed: "${q}" - ${err.message}`)
      return { ok: false, url: '', title: '', results: [] }
    })
  )
  const serpResultsArray = await Promise.all(serpPromises)

  // Merge and rank search results
  const candidatesMap = new Map<string, { title: string; url: string; snippet: string; score: number }>()
  for (let i = 0; i < plan.queries.length; i++) {
    const page = serpResultsArray[i]
    if (!page || !page.results) continue

    page.results.forEach((r, idx) => {
      if (visitedUrls.has(r.url)) return

      // Calculate candidate relevance score based on search snippets
      let score = (10 - idx) // position score
      const textToMatch = `${r.title} ${r.snippet || ''}`.toLowerCase()
      normalizedConcepts.forEach(c => {
        if (textToMatch.includes(c)) score += 3
      })

      const existing = candidatesMap.get(r.url)
      if (!existing || existing.score < score) {
        candidatesMap.set(r.url, { title: r.title, url: r.url, snippet: r.snippet || '', score })
      }
    })
  }

  const sortedCandidates = Array.from(candidatesMap.values()).sort((a, b) => b.score - a.score)
  onProgress(`Discovered ${sortedCandidates.length} potential search results. Preparing to probe top hits.`)

  // We allocate pages: e.g. half for Layer 0, half for Layer 1
  const initialCrawlCount = Math.min(Math.ceil(maxPages / 2) + 1, sortedCandidates.length, maxPages)
  const initialToCrawl = sortedCandidates.slice(0, initialCrawlCount)

  // Harvesting set for Deep Link exploration (Layer 1)
  const harvestedLinksMap = new Map<string, { url: string; anchorText: string; score: number }>()

  // Helper for background probing
  async function probePage(url: string, depthLevel: number): Promise<void> {
    if (visitedUrls.has(url)) return
    visitedUrls.add(url)

    onProgress(`[Depth ${depthLevel}] Probing: ${url}`)
    const bgTab = deps.tabs.create('about:blank', { background: true })
    const bgTabId = bgTab.id
    try {
      deps.tabs.navigate(bgTabId, url)
      await waitForPageReady(deps.tabs, bgTabId)

      const capture = await deps.extractor.run(bgTabId)
      const md = capture.content?.markdown || ''
      const wall = detectPageWall(md)

      if (wall) {
        onProgress(`[Depth ${depthLevel}] Warning: Potential wall detected on ${url} (${wall})`)
      }

      const brief = briefPageForSearch(capture, { query })
      completedProbes.push({
        url,
        title: capture.title || 'Untitled Page',
        depth: depthLevel,
        brief,
        wall
      })
      sourcesVisited.push({
        url,
        title: capture.title || 'Untitled Page',
        depth: depthLevel
      })

      // Link Harvesting: Extract anchor links to crawl deeper
      if (capture.actions && Array.isArray(capture.actions)) {
        capture.actions.forEach(act => {
          if (act.role === 'link' && act.value && act.value.startsWith('http')) {
            const targetUrl = act.value.split('#')[0] // strip hash anchor
            if (visitedUrls.has(targetUrl) || targetUrl === url) return

            // Score link based on anchor text and path name
            const linkScore = scoreLink(targetUrl, act.name || '', normalizedConcepts)
            if (linkScore > 0) {
              const existing = harvestedLinksMap.get(targetUrl)
              if (!existing || existing.score < linkScore) {
                harvestedLinksMap.set(targetUrl, {
                  url: targetUrl,
                  anchorText: act.name || 'Link',
                  score: linkScore
                })
              }
            }
          }
        })
      }
    } catch (err: any) {
      onProgress(`[Depth ${depthLevel}] Failed to probe ${url}: ${err.message}`)
    } finally {
      try { deps.tabs.close(bgTabId) } catch { /* ignore */ }
    }
  }

  // Crawl Layer 0 pages (parallel limit of 2 to keep Electron completely fluid and responsive)
  const batchSize = 2
  for (let i = 0; i < initialToCrawl.length; i += batchSize) {
    if (completedProbes.length >= maxPages) break
    const batch = initialToCrawl.slice(i, i + batchSize)
    await Promise.all(batch.map(item => probePage(item.url, 0)))
  }

  // 3. LAYER 1: Deep Crawling of Harvested Links
  if (depth > 1 && completedProbes.length < maxPages && harvestedLinksMap.size > 0) {
    const remainingBudget = maxPages - completedProbes.length
    const sortedHarvested = Array.from(harvestedLinksMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, remainingBudget)

    onProgress(`Harvested ${harvestedLinksMap.size} relevant outbound links. Crawling top ${sortedHarvested.length} deep sources.`)

    for (let i = 0; i < sortedHarvested.length; i += batchSize) {
      if (completedProbes.length >= maxPages) break
      const batch = sortedHarvested.slice(i, i + batchSize)
      await Promise.all(batch.map(item => probePage(item.url, 1)))
    }
  }

  // 4. Compile High-Density Markdown Dossier
  onProgress('Synthesizing research evidence and compiling final dossier...')
  let mdReport = `# DEEP SEARCH DOSSIER: ${query.toUpperCase()}\n\n`

  mdReport += `## 🎯 RESEARCH GOAL & STRATEGY\n`
  mdReport += `* **Target Goal**: ${query}\n`
  mdReport += `* **Formulated Questions**:\n${plan.questions.map(q => `  - ${q}`).join('\n')}\n`
  mdReport += `* **Target Concept Filters**: ${plan.concepts.map(c => `\`${c}\``).join(', ')}\n\n`

  mdReport += `## 🔎 QUERIES EXECUTED\n`
  plan.queries.forEach(q => {
    mdReport += `* \`${q}\`\n`
  })
  mdReport += `\n`

  mdReport += `## 🌐 SOURCES VISITED (${completedProbes.length})\n`
  completedProbes.forEach((src, idx) => {
    const wallStr = src.wall ? ` *(Wall: ${src.wall})*` : ''
    mdReport += `${idx + 1}. **[${src.title}](${src.url})** (Depth: ${src.depth})${wallStr}\n`
  })
  mdReport += `\n`

  mdReport += `## 📊 EXTRACTED HIGH-DENSITY EVIDENCE\n\n`
  completedProbes.forEach((src, idx) => {
    mdReport += `### Source [${idx + 1}]: ${src.title}\n`
    mdReport += `**URL**: ${src.url} (Depth: ${src.depth})\n\n`
    mdReport += `\`\`\`text\n${src.brief.trim()}\n\`\`\`\n\n`
    mdReport += `---\n\n`
  })

  // Suggested secondary links that were discovered but not crawled (to save budget)
  const remainingLinks = Array.from(harvestedLinksMap.values())
    .filter(link => !visitedUrls.has(link.url))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  if (remainingLinks.length > 0) {
    mdReport += `## 🔗 RELEVANT UNVISITED LINKS DISCOVERED\n`
    remainingLinks.forEach(link => {
      mdReport += `* **[${link.anchorText || 'Link'}](${link.url})** (Relevance Score: ${link.score})\n`
    })
    mdReport += `\n`
  }

  mdReport += `*Dossier generated deterministically using Gladdis Deep Search Agent.*`

  onProgress(`Deep Search Complete! Visited ${completedProbes.length} pages. Generated high-density dossier.`)

  return {
    ok: true,
    text: mdReport,
    queriesRun: plan.queries,
    sourcesVisited
  }
}

// Private Helpers

async function waitForPageReady(tabs: TabManager, tabId: string, timeoutMs = 12_000): Promise<void> {
  try {
    await tabs.cdpSend(tabId, 'Network.enable', { maxPostDataSize: 0, maxResourceBufferSize: 0 })
  } catch { /* non-fatal */ }

  await tabs.waitForNavigationSettled(tabId, timeoutMs)

  // Extra grace period for SPA content mounting after initial load event
  await sleep(600)
}

function detectPageWall(markdown: string): string | undefined {
  const md = markdown.toLowerCase()
  if (md.includes('accept cookies') || md.includes('agree to our cookie') || md.includes('cookie consent')) {
    return 'cookie_banner'
  }
  if (md.includes('paywall') || md.includes('subscribe to read') || md.includes('premium content')) {
    return 'paywall'
  }
  if (md.includes('sign in') && md.includes('password') && md.length < 1500) {
    return 'login_wall'
  }
  if (md.trim().length === 0) {
    return 'blank'
  }
  return undefined
}

function scoreLink(url: string, anchorText: string, terms: string[]): number {
  const lowerUrl = url.toLowerCase()
  const lowerAnchor = anchorText.toLowerCase()

  // Ignore useless / social / share links
  const ignorePatterns = [
    'facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'youtube.com',
    'tiktok.com', 'reddit.com', 'pinterest.com', 'login', 'signup', 'share', 'subscribe',
    'privacy', 'terms', 'cookies', 'about-us', 'contact-us', 'mailto:'
  ]
  if (ignorePatterns.some(p => lowerUrl.includes(p))) {
    return -1
  }

  let score = 0
  for (const t of terms) {
    if (lowerAnchor.includes(t)) {
      score += 10 // high weight for anchor text
    }
    if (lowerUrl.includes(t)) {
      score += 2 // lower weight for url keywords
    }
  }
  return score
}
