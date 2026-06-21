import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  SearchQueryOptimizer,
  AdvancedSearchEngine,
  DeepResearchAgent,
  ProgressiveResearchSession,
  type ExpandedSearchPlan
} from './searchPipeline'

// Mock runHiddenSearch
vi.mock('../models/hiddenSearch', () => ({
  runHiddenSearch: vi.fn(async (query: string) => {
    if (query.includes('error')) {
      return {
        ok: true,
        url: 'https://duckduckgo.com/?q=error',
        title: 'Error Search Results',
        results: [
          { title: 'Unhandled Promise Rejection TS', url: 'https://github.com/microsoft/typescript/issues/123', snippet: 'Void promise rejection' },
          { title: 'TypeScript Void Promises', url: 'https://stackoverflow.com/q/456', snippet: 'How to handle void promises in TS' }
        ]
      }
    }
    return {
      ok: true,
      url: 'https://duckduckgo.com/',
      title: 'General Results',
      results: [
        { title: 'General Info', url: 'https://example.com/info', snippet: 'some snippet text' }
      ]
    }
  })
}))

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('Advanced Search Pipeline', () => {
  let mockChatService: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockChatService = {
      complete: vi.fn()
    }
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => '<html><body>Sample content</body></html>'
    })
  })

  describe('SearchQueryOptimizer', () => {
    it('successfully optimizes a raw natural language prompt into a search plan', async () => {
      const mockPlan: ExpandedSearchPlan = {
        needsClarification: false,
        clarifyingQuestions: [],
        refinedIntent: 'How to handle promise void error in TypeScript',
        targetQueries: [
          'typescript unhandled promise rejection void',
          'ts promise void error stackoverflow'
        ],
        hypotheses: ['The return type mismatch causes uncaught exception.'],
        prioritizedDomains: ['github.com', 'stackoverflow.com']
      }

      mockChatService.complete.mockResolvedValueOnce(JSON.stringify(mockPlan))

      const optimizer = new SearchQueryOptimizer(mockChatService, 'test-model')
      const plan = await optimizer.optimizePrompt('error promise void TS')

      expect(plan.needsClarification).toBe(false)
      expect(plan.refinedIntent).toBe('How to handle promise void error in TypeScript')
      expect(plan.targetQueries).toHaveLength(2)
      expect(plan.prioritizedDomains).toContain('github.com')
      expect(mockChatService.complete).toHaveBeenCalledTimes(1)
    })

    it('falls back to a default query plan if the model prompt optimization fails', async () => {
      mockChatService.complete.mockRejectedValueOnce(new Error('LLM timeout'))

      const optimizer = new SearchQueryOptimizer(mockChatService, 'test-model')
      const plan = await optimizer.optimizePrompt('unoptimized prompt')

      expect(plan.needsClarification).toBe(false)
      expect(plan.refinedIntent).toBe('unoptimized prompt')
      expect(plan.targetQueries).toEqual(['unoptimized prompt'])
    })
  })

  describe('AdvancedSearchEngine', () => {
    it('gathers, deduplicates, and ranks multi-query search results with correct domain boosts', async () => {
      const engine = new AdvancedSearchEngine()
      const plan: ExpandedSearchPlan = {
        needsClarification: false,
        clarifyingQuestions: [],
        refinedIntent: 'promise void TS error',
        targetQueries: ['ts promise error', 'unhandled promise void'],
        hypotheses: [],
        prioritizedDomains: ['github.com', 'stackoverflow.com']
      }

      const results = await engine.executeSearchPlan(plan)

      // Deduplicated unique results should be present
      expect(results.length).toBeGreaterThan(0)

      // Github result should be heavily boosted due to prioritizedDomains and keyword matching
      const githubResult = results.find(r => r.url.includes('github.com'))
      expect(githubResult).toBeDefined()
      expect(githubResult!.relevanceScore).toBeGreaterThan(0.5)
    })
  })

  describe('DeepResearchAgent', () => {
    it('fetches actual HTML content, strips tags, and extracts concise page summaries via ChatService', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body><div>Here is actual technical content about void promise.</div></body></html>'
      })

      mockChatService.complete.mockResolvedValueOnce('Summary from github page content.')

      const agent = new DeepResearchAgent(mockChatService, 'test-model')
      const initialResults = [
        {
          title: 'GitHub Issue 123',
          url: 'https://github.com/microsoft/typescript/issues/123',
          snippet: 'Void promise rejection',
          originQuery: 'error promise void TS',
          relevanceScore: 0.9
        }
      ]

      const plan: ExpandedSearchPlan = {
        needsClarification: false,
        clarifyingQuestions: [],
        refinedIntent: 'void promise error TS',
        targetQueries: [],
        hypotheses: [],
        prioritizedDomains: []
      }

      const digested = await agent.digestTopResults(initialResults, plan, 1)

      expect(digested[0].extractedContent).toBe('Summary from github page content.')
      expect(mockFetch).toHaveBeenCalledWith('https://github.com/microsoft/typescript/issues/123', expect.any(Object))
      expect(mockChatService.complete).toHaveBeenCalledTimes(1)
    })
  })

  describe('ProgressiveResearchSession', () => {
    it('orchestrates the entire research workflow and returns final session state', async () => {
      const mockPlan: ExpandedSearchPlan = {
        needsClarification: false,
        clarifyingQuestions: [],
        refinedIntent: 'How to handle promise void error in TypeScript',
        targetQueries: ['ts promise error'],
        hypotheses: ['Returning Promise<void> directly instead of awaiting causes uncaught exception.'],
        prioritizedDomains: ['github.com']
      }

      mockChatService.complete
        .mockResolvedValueOnce(JSON.stringify(mockPlan)) // Query Optimizer
        .mockResolvedValueOnce('Summary of Github source page.') // DeepResearchAgent digest 1
        .mockResolvedValueOnce('Summary of StackOverflow source page.') // DeepResearchAgent digest 2
        .mockResolvedValueOnce('The ultimate synthesized solution guide.') // ProgressiveResearchSession final synthesis

      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '<html><body>Code: const handle = async (): Promise<void> => {}</body></html>'
      })

      const optimizer = new SearchQueryOptimizer(mockChatService, 'test-model')
      const engine = new AdvancedSearchEngine()
      const reader = new DeepResearchAgent(mockChatService, 'test-model')

      const session = new ProgressiveResearchSession(
        optimizer,
        engine,
        reader,
        mockChatService,
        'test-model',
        'error promise void TS'
      )

      const progressTicks: string[] = []
      const onProgress = (msg: string) => {
        progressTicks.push(msg)
      }

      const finalState = await session.runSession(onProgress)

      expect(finalState.plan).toBeDefined()
      expect(finalState.allResults.length).toBeGreaterThan(0)
      expect(finalState.synthesizedAnswer).toBe('The ultimate synthesized solution guide.')
      expect(progressTicks).toContain('Optimizing user prompt and engineering sub-queries...')
      expect(progressTicks).toContain('Dispatching parallel sub-queries:\n - "ts promise error"')
      expect(progressTicks).toContain('Fetching and digesting high-relevance web resources...')
      expect(progressTicks).toContain('Synthesizing collected data into a unified, high-quality answer...')

      const output = session.renderProgressiveOutput()
      expect(output).toContain('## 🔍 Search Pipeline Report: *"How to handle promise void error in TypeScript"*')
      expect(output).toContain('The ultimate synthesized solution guide.')
    })
  })
})
