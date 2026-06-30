/**
 * Narrow LLM dependency shared across the model surface (providers, agent
 * loop, capability broker, tools). One non-streaming text completion is all
 * any caller needs from the host: the host wires this to ChatService's
 * existing anthropic()/google()/openai()/grok() clients.
 *
 * Lives here (not in any provider file) so importing it never drags in a
 * provider runtime, and stays test-stubbable as a plain function.
 */
export interface LlmCompleteOptions {
  /** Stage label for logging/adapter-specific budgeting. */
  stage?: string
  /** Provider output cap for this call. Input prompt size is controlled by callers. */
  maxOutputTokens?: number
  /** Optional conversation key for provider-side prompt caching or routing. */
  conversationId?: string | null
}

export type LlmComplete = (system: string, user: string, options?: LlmCompleteOptions) => Promise<string>
