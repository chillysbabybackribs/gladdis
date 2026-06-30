import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_SYSTEM } from '../prompts'
import { CLAUDE_CODE_BROWSER_INSTRUCTIONS } from './browserTools'

interface MemoryEvalScenario {
  name: string
  request: string
  requiredPhrases: string[]
}

const MEMORY_EVAL_SCENARIOS: MemoryEvalScenario[] = [
  {
    name: 'reads memory before re-asking for known context on long tasks',
    request:
      'Continue the multi-step refactor from yesterday and preserve the workspace conventions we already chose.',
    requiredPhrases: [
      'call memory_read before re-asking for context that may already be known'
    ]
  },
  {
    name: 'writes durable task notes after meaningful discoveries',
    request:
      'Track the migration decisions, identifiers, and partial findings while you work through the remaining steps.',
    requiredPhrases: [
      'use memory_write for durable decisions/constraints/identifiers'
    ]
  },
  {
    name: 'creates task-scoped memory for a durable subtask',
    request:
      'Split the release work into a dedicated subtask and keep those notes separate from the rest of the workspace.',
    requiredPhrases: [
      'use memory_create_task for task-specific notes'
    ]
  },
  {
    name: 'clears stale notes when they would mislead later steps',
    request:
      'The earlier rollout plan is obsolete now, so update your stored notes before you continue.',
    requiredPhrases: [
      'use memory_forget to clear stale notes when plans change'
    ]
  }
]

function expectScenarioCovered(prompt: string, scenario: MemoryEvalScenario): void {
  for (const phrase of scenario.requiredPhrases) {
    expect(prompt, `scenario "${scenario.name}" for request "${scenario.request}"`).toContain(phrase)
  }
}

describe('Claude Code memory eval', () => {
  it('covers representative long-task memory behaviors in the real Claude prompt path', () => {
    expect(CLAUDE_CODE_SYSTEM).toContain(CLAUDE_CODE_BROWSER_INSTRUCTIONS)

    for (const scenario of MEMORY_EVAL_SCENARIOS) {
      expectScenarioCovered(CLAUDE_CODE_BROWSER_INSTRUCTIONS, scenario)
      expectScenarioCovered(CLAUDE_CODE_SYSTEM, scenario)
    }
  })

  it('tells Claude to store concise reusable facts instead of transcript dumps', () => {
    expect(CLAUDE_CODE_BROWSER_INSTRUCTIONS).toContain(
      'Store concise, reusable facts rather than large transcript dumps.'
    )
  })

  it('makes the unrestricted local permission posture explicit', () => {
    expect(CLAUDE_CODE_SYSTEM).toContain('--dangerously-skip-permissions')
    expect(CLAUDE_CODE_SYSTEM).toContain('Do not stop for Claude permission or approval workflows')
    expect(CLAUDE_CODE_SYSTEM).toContain('do not ask the user to manually run local commands just to bypass a Claude-side restriction')
  })
})
