import { runHiddenSearch, type HiddenSearchResult, type HiddenSearchPage } from '../models/hiddenSearch'
import type { ChatService } from '../models/ChatService'

/**
 * Interface representing the model-redesigned search plan.
 * Takes an unoptimized natural language prompt and transforms it into an elegant, structured execution plan.
 */
export interface ExpandedSearchPlan {
  /**
   * Flag indicating whether the user's prompt is too vague, ambiguous, or lacks sufficient context to yield high-quality search results.
   * If true, the system should pause and present clarifying questions to the user first.
   */
  needsClarification: boolean

  /**
   * Bullet points or specific clarifying questions to ask the user to refine their search intent.
   */
  clarifyingQuestions: string[]

  /**
   * A clean, highly optimized synthesis of the user's original query (the "ideal technical prompt").
   */
  refinedIntent: string

  /**
   * 3 to 5 highly specific, distinct search queries targeting different information angles.
   * E.g., one query for official docs, one for GitHub issues/errors, one for technical blogs, one for code syntax.
   */
  targetQueries: string[]

  /**
   * The hypotheses or core technical assumptions we are testing with this search.
   * What potential solutions or architectures does the model suspect are correct?
   */
  hypotheses: string[]

  /**
   * Target domains to prioritize (e.g., github.com, stackoverflow.com, official docs) or avoid.
   */
  prioritizedDomains: string[]
}

/**
 * Unified search result representation.
 */
export interface EnhancedSearchResult extends HiddenSearchResult {
  /** Source query that produced this result (useful for tracking coverage across angles). */
  originQuery: string
  /** Normalized quality/relevance score from 0.0 to 1.0 based on keyword overlap, domain authority, and title relevance. */
  relevanceScore: number
  /** Normalized page contents (if fetched). */
  extractedContent?: string
}

/**
 * Class representing a collaborative, stateful research session.
 * Retains information across multiple iterations and queries.
 */
export interface ResearchState {
  originalPrompt: string
  plan?: ExpandedSearchPlan
  allResults: EnhancedSearchResult[]
  unansweredQuestions: string[]
  synthesizedAnswer?: string
  visitedUrls: string[]
}

/**
 * 1. THE MODEL HARNESS: Prompt Redesigner and Query Optimizer
 * This class handles taking unoptimized, natural language inputs and optimizing them into a multi-faceted search plan.
 */
export class SearchQueryOptimizer {
  constructor(private chatService: ChatService, private modelId: string) {}

  /**
   * Takes a raw natural language prompt and produces a highly optimized, structured Search Plan.
   */
  async optimizePrompt(userPrompt: string): Promise<ExpandedSearchPlan> {
    const systemPrompt = `You are a world-class Research Director & Information Architect.
Your task is to analyze a user's natural language, unoptimized, or ambiguous prompt, and design a high-precision multi-query research plan.

Instructions:
1. Assess if the user's prompt is highly ambiguous or lacks critical context (e.g. "it crashed", "how do I fix that error"). If so, set "needsClarification": true and provide 2-3 precise, targeted clarifying questions.
2. Formulate a "refinedIntent" that articulates the exact technical or logical question the user is seeking to answer.
3. Generate 3 to 5 distinct, highly-targeted search queries ("targetQueries") targeting different facets of the problem.
   - Syntax/API query (direct code structures or error codes)
   - Conceptual/Documentation query (official specs, manuals, best practices)
   - Diagnostic/Community query (GitHub issues, StackOverflow, forum discussions)
   - Contextual query (synonyms or alternative approaches)
4. List the core "hypotheses" or technical assumptions you intend to test (what is the likely cause of the issue or correct architectural path?).
5. Identify "prioritizedDomains" that are authoritative for this specific technical stack (e.g. ['npmjs.com', 'developer.mozilla.org', 'react.dev']).

Output strictly a JSON object conforming to this TypeScript interface:
{
  "needsClarification": boolean,
  "clarifyingQuestions": string[],
  "refinedIntent": string,
  "targetQueries": string[],
  "hypotheses": string[],
  "prioritizedDomains": string[]
}

Ensure your response is ONLY valid JSON. Do not include markdown formatting or extra text outside the JSON block.`

    try {
      const responseText = await this.chatService.complete(
        this.modelId,
        systemPrompt,
        `User Prompt: "${userPrompt}"`,
        { stage: 'Search Query Optimization' }
      )

      return this.parseJsonResponse<ExpandedSearchPlan>(responseText)
    } catch (error) {
      console.error('[SearchQueryOptimizer] Error during prompt optimization, falling back to basic plan.', error)
      return this.createFallbackPlan(userPrompt)
    }
  }

  private parseJsonResponse<T>(text: string): T {
    // Strip markdown formatting like ```json or ``` if present
    const cleanText = text
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim()

    return JSON.parse(cleanText) as T
  }

  private createFallbackPlan(userPrompt: string): ExpandedSearchPlan {
    return {
      needsClarification: false,
      clarifyingQuestions: [],
      refinedIntent: userPrompt,
      targetQueries: [userPrompt],
      hypotheses: ['Analyzing query using default single-search pass.'],
      prioritizedDomains: []
    }
  }
}

/**
 * 2. THE ADVANCED SEARCH PIPELINE: Best-in-breed multi-query aggregation, deduplication & ranking
 */
export class AdvancedSearchEngine {
  /**
   * Executes multiple queries in parallel, aggregates, deduplicates, and scores results based on quality metrics.
   */
  async executeSearchPlan(plan: ExpandedSearchPlan, limitPerQuery = 5): Promise<EnhancedSearchResult[]> {
    console.log(`[AdvancedSearchEngine] Executing search plan with ${plan.targetQueries.length} queries...`)

    // Run searches concurrently to save latency
    const searchPromises = plan.targetQueries.map(async (query) => {
      try {
        const page: HiddenSearchPage = await runHiddenSearch(query, limitPerQuery)
        if (!page.ok || !page.results) {
          return []
        }
        return page.results.map((r) => ({
          ...r,
          originQuery: query,
          relevanceScore: 0.5 // Default initial score
        }))
      } catch (err) {
        console.error(`[AdvancedSearchEngine] Single query failed: "${query}"`, err)
        return []
      }
    })

    const resultsArray = await Promise.all(searchPromises)
    const flatResults: EnhancedSearchResult[] = resultsArray.flat()

    // Deduplicate results by URL
    const uniqueMap = new Map<string, EnhancedSearchResult>()
    for (const res of flatResults) {
      const existing = uniqueMap.get(res.url)
      if (existing) {
        // If a URL was found by multiple queries, it's highly relevant! Boost its score
        existing.relevanceScore += 0.2
        // Append source query origin
        if (!existing.originQuery.includes(res.originQuery)) {
          existing.originQuery += `, ${res.originQuery}`
        }
      } else {
        uniqueMap.set(res.url, res)
      }
    }

    const uniqueResults = Array.from(uniqueMap.values())

    // Score and rank each result based on domains and keywords
    const rankedResults = uniqueResults.map((item) => {
      let score = item.relevanceScore

      // 1. Domain Match Boosting
      const lowerUrl = item.url.toLowerCase()
      const domainMatch = plan.prioritizedDomains.some((d) => lowerUrl.includes(d.toLowerCase()))
      if (domainMatch) {
        score += 0.3
      }

      // Major developer communities/reference boost
      if (lowerUrl.includes('github.com') || lowerUrl.includes('stackoverflow.com')) {
        score += 0.1
      }
      if (lowerUrl.includes('wikipedia.org') || lowerUrl.includes('reddit.com')) {
        score += 0.05
      }

      // 2. Keyword Match in Title/Snippet
      const keywords = plan.refinedIntent.toLowerCase().split(/\s+/)
      const matchText = `${item.title} ${item.snippet ?? ''}`.toLowerCase()
      let keywordHits = 0
      for (const kw of keywords) {
        if (kw.length > 3 && matchText.includes(kw)) {
          keywordHits++
        }
      }
      const keywordBoost = Math.min(keywordHits * 0.05, 0.25)
      score += keywordBoost

      // Clip score to 0.0 - 1.0 range
      item.relevanceScore = Math.max(0.0, Math.min(1.0, score))
      return item
    })

    // Sort by descending score
    return rankedResults.sort((a, b) => b.relevanceScore - a.relevanceScore)
  }
}

/**
 * 3. DEEP RETRIEVAL LAYER: Scrape, Digest & Reason over actual page contents
 */
export class DeepResearchAgent {
  constructor(private chatService: ChatService, private modelId: string) {}

  /**
   * Takes the top search results, reads their actual full-text content, and extracts precise summaries targeting the user's intent.
   */
  async digestTopResults(
    results: EnhancedSearchResult[],
    plan: ExpandedSearchPlan,
    maxLinksToFetch = 3,
    tabId?: string,
    onProgress?: (status: string) => void
  ): Promise<EnhancedSearchResult[]> {
    const targets = results.slice(0, maxLinksToFetch)
    console.log(`[DeepResearchAgent] Deep retrieving content for the top ${targets.length} websites...`)

    const enriched: EnhancedSearchResult[] = []

    for (const res of targets) {
      try {
        let cleanText = ''
        let title = res.title

        if (tabId && this.chatService.tools?.tabs) {
          const msg = `Navigating browser tab to: ${res.url}`
          if (onProgress) onProgress(msg)
          console.log(`[DeepResearchAgent] ${msg}`)

          await this.chatService.tools.tabs.navigate(tabId, res.url)
          await this.chatService.tools.tabs.waitForNavigationSettled(tabId, 10000)

          if (this.chatService.tools.extractor) {
            const capture = await this.chatService.tools.extractor.run(tabId)
            cleanText = capture.content?.text || ''
            if (capture.title) {
              title = capture.title
            }
          }
        }

        // If visual tab extraction failed or was not used, fall back to global fetch
        if (!cleanText) {
          const msg = `Fetching page content via background HTTP: ${res.url}`
          if (onProgress) onProgress(msg)
          console.log(`[DeepResearchAgent] ${msg}`)

          const response = await fetch(res.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/115.0.0.0' },
            signal: AbortSignal.timeout(8000)
          })

          if (response.ok) {
            const html = await response.text()
            cleanText = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          }
        }

        if (cleanText) {
          const contentSnippet = cleanText.slice(0, 10000) // Keep top 10k chars

          // Use the LLM to extract the exact answer to our query from this page text
          const pageSynthesizerPrompt = `You are a high-fidelity web scraper & technical reading assistant.
You are researching: "${plan.refinedIntent}"

Here is the raw text content extracted from the webpage: ${res.url}
Title: "${title}"

Extract and summarize any specific answers, code snippets, diagnostic info, or workarounds related directly to "${plan.refinedIntent}" from this page content.
If the page doesn't contain useful information, output "No relevant technical data found on this page."
Keep your summary factual, concise (under 300 words), and preserve any code snippets or exact technical solutions verbatim.`

          const extractedDigest = await this.chatService.complete(
            this.modelId,
            pageSynthesizerPrompt,
            `Webpage Content: ${contentSnippet}`,
            { stage: 'Deep Site Digest' }
          )

          enriched.push({
            ...res,
            title,
            extractedContent: extractedDigest
          })
        } else {
          enriched.push(res)
        }
      } catch (err) {
        console.error(`[DeepResearchAgent] Failed to retrieve content for ${res.url}`, err)
        enriched.push(res) // Keep original snippet as fallback
      }
    }

    // Combine enriched with the rest of the results (unfetched)
    return [...enriched, ...results.slice(maxLinksToFetch)]
  }
}

/**
 * 4. COLLABORATIVE OUTCOME LAYER: Synthesize and interactively deliver outcomes
 */
export class ProgressiveResearchSession {
  private state: ResearchState

  constructor(
    private optimizer: SearchQueryOptimizer,
    private engine: AdvancedSearchEngine,
    private reader: DeepResearchAgent,
    private chatService: ChatService,
    private modelId: string,
    originalPrompt: string
  ) {
    this.state = {
      originalPrompt,
      allResults: [],
      unansweredQuestions: [],
      visitedUrls: []
    }
  }

  /**
   * Runs the entire research pipeline with progressive state reporting and outcome synthesis.
   */
  async runSession(onProgress: (status: string) => void, tabId?: string): Promise<ResearchState> {
    // Phase 1: Optimize prompt & expand queries
    onProgress('Optimizing user prompt and engineering sub-queries...')
    const plan = await this.optimizer.optimizePrompt(this.state.originalPrompt)
    this.state.plan = plan

    if (plan.needsClarification) {
      onProgress('Prompt requires further user clarification. Pausing pipeline.')
      this.state.unansweredQuestions = plan.clarifyingQuestions
      return this.state
    }

    // Phase 2: Execute parallel queries
    onProgress(`Dispatching parallel sub-queries:\n${plan.targetQueries.map(q => ` - "${q}"`).join('\n')}`)
    const rankedResults = await this.engine.executeSearchPlan(plan)
    this.state.allResults = rankedResults

    if (rankedResults.length === 0) {
      onProgress('No web search results could be retrieved.')
      this.state.synthesizedAnswer = 'We were unable to find any online search results for your query. Please refine your inputs.'
      return this.state
    }

    // Phase 3: Fetch page contents and extract digests for top 3 hits
    onProgress('Fetching and digesting high-relevance web resources...')
    const digestedResults = await this.reader.digestTopResults(rankedResults, plan, 3, tabId, onProgress)
    this.state.allResults = digestedResults
    this.state.visitedUrls = digestedResults.slice(0, 3).map((r) => r.url)

    // Phase 4: Final synthesis of knowledge and interactive outcome construction
    onProgress('Synthesizing collected data into a unified, high-quality answer...')
    
    const contextSnippet = digestedResults
      .slice(0, 5)
      .map((r, i) => {
        return `[Source #${i + 1}] Title: ${r.title}\nURL: ${r.url}\nRelevance: ${(r.relevanceScore * 100).toFixed(0)}%\nContent Summary:\n${r.extractedContent || r.snippet || 'No summary available.'}\n`
      })
      .join('\n\n')

    const synthesisPrompt = `You are a Principal Technical Researcher.
You are tasked with resolving the user's intent: "${plan.refinedIntent}"
We have executed a multi-angle parallel search, fetched high-relevance pages, and digested their contents.

Here is the structured knowledge we retrieved from our deep search:
${contextSnippet}

Hypotheses we had:
${plan.hypotheses.map(h => ` - ${h}`).join('\n')}

Your goal:
1. Deliver a comprehensive, highly authoritative, and direct "Completed Outcome" answering the user's query.
2. Outline the exact solution, with code snippets, diagnostic explanations, or architectural best practices.
3. Call out which Source URLs have the most definitive evidence.
4. If there is still some ambiguity or if further details would help, propose 2 logical next steps or refinement directions the user can ask you to take.`

    const finalAnswer = await this.chatService.complete(
      this.modelId,
      synthesisPrompt,
      `Original Query: "${this.state.originalPrompt}"\nPlease synthesize the definitive guide/response.`,
      { stage: 'Final Search Synthesis' }
    )

    this.state.synthesizedAnswer = finalAnswer
    return this.state
  }

  /**
   * Serializes the research state for the user interface.
   */
  renderProgressiveOutput(): string {
    const plan = this.state.plan
    if (!plan) return 'Initiating search pipeline...'

    let md = `## 🔍 Search Pipeline Report: *"${plan.refinedIntent}"*\n\n`

    if (plan.needsClarification) {
      md += `### ⚠️ Ambiguity Detected\nTo deliver the best-in-breed results, please clarify your intent:\n`
      md += plan.clarifyingQuestions.map((q) => `* **${q}**`).join('\n')
      md += `\n`
      return md
    }

    md += `### 📈 Research Plan & Hypotheses\n`
    md += `* **Target Sub-Queries Run:**\n`
    md += plan.targetQueries.map((q) => `  * \`${q}\``).join('\n') + '\n'
    md += `* **Initial Technical Hypotheses:**\n`
    md += plan.hypotheses.map((h) => `  * *${h}*`).join('\n') + '\n\n'

    md += `### 🌐 Top Resources Analyzed\n`
    md += this.state.allResults
      .slice(0, 5)
      .map((r, i) => {
        const isDigested = !!r.extractedContent
        const icon = isDigested ? '📖 [Fully Digested]' : '🔗'
        return `${i + 1}. ${icon} [**${r.title}**](${r.url}) - *(Relevance: ${(r.relevanceScore * 100).toFixed(0)}%)*`
      })
      .join('\n') + '\n\n'

    if (this.state.synthesizedAnswer) {
      md += `### 🏆 Synthesized Answer\n\n${this.state.synthesizedAnswer}\n`
    } else {
      md += `*Analyzing extracted page contents and finalizing answer...*\n`
    }

    return md
  }
}
