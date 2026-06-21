import type { PageCapture } from '../../../shared/types'
import type { LlmComplete } from './Planner'
import type { Trajectory } from './types'

const MAX_FINAL_CONTENT_CHARS = 4_000
const MAX_STEP_INTENT_CHARS = 140
const MAX_TRAJECTORY_STEPS = 30
const MAX_LINKS = 24
const MAX_HEADINGS = 24
const MAX_EVIDENCE_ITEMS = 12
const MAX_EVIDENCE_TEXT_CHARS = 900
const FINAL_RESPONSE_OUTPUT_TOKENS = 2_200

const FINAL_RESPONSE_SYSTEM = [
  'You are the final answer stage for a deterministic browser automation pipeline.',
  'The browser pipeline has already navigated and verified steps. Your job is to answer the user\'s original task using only the captured page evidence and run trajectory below.',
  'Be direct and useful. If the evidence is insufficient for the requested answer, say that clearly, summarize what was actually found, and name the next browser steps needed.',
  'Do not invent listings, metrics, prices, URLs, or rankings that are not present in the evidence.',
  'Use concise markdown.'
].join('\n')

export async function generatePipelineFinalResponse(opts: {
  task: string
  trajectory: Trajectory
  finalCapture: PageCapture
  llm: LlmComplete
}): Promise<string> {
  const user = [
    `USER TASK:\n${opts.task}`,
    '',
    'PIPELINE RUN SUMMARY:',
    describeTrajectory(opts.trajectory),
    '',
    'CAPTURED PAGE EVIDENCE:',
    describeEvidence(opts.trajectory),
    '',
    'FINAL PAGE CAPTURE:',
    describeCapture(opts.finalCapture),
    '',
    'Write the response the user should see now that the pipeline is complete.'
  ].join('\n')

  return (
    await opts.llm(FINAL_RESPONSE_SYSTEM, user, {
      stage: 'pipeline:final',
      maxOutputTokens: FINAL_RESPONSE_OUTPUT_TOKENS
    })
  ).trim()
}

function describeTrajectory(t: Trajectory): string {
  const passed = t.steps.filter((s) => s.status === 'passed' || s.status === 'retried-pass').length
  const replans = t.steps.filter((s) => s.usedLlm).length
  const visibleSteps = t.steps.slice(0, MAX_TRAJECTORY_STEPS)
  const steps = visibleSteps.map((s, i) => {
    const status = s.usedLlm ? `${s.status}, replanned` : s.status
    const intent = truncate(s.step.intent, MAX_STEP_INTENT_CHARS)
    const err = s.error ? ` Error: ${truncate(s.error, 120)}` : ''
    return `${i + 1}. [${status}] ${intent}${err}`
  })
  if (t.steps.length > visibleSteps.length) {
    steps.push(`...${t.steps.length - visibleSteps.length} more step(s) omitted from the synthesis prompt.`)
  }

  return [
    `Success: ${t.success}`,
    `Site: ${t.site}`,
    `Steps: ${t.steps.length}; passed: ${passed}; replans: ${replans}`,
    `LLM calls: ${t.llmCalls}; deterministic checks: ${t.deterministicChecks}`,
    `Time: ${(t.tookMs / 1000).toFixed(1)}s`,
    '',
    steps.join('\n')
  ].join('\n')
}

function describeCapture(capture: PageCapture): string {
  const links = uniqueLinks(capture)
  const content = capture.content.markdown || capture.content.text || ''
  return JSON.stringify(
    {
      url: capture.url,
      pageTitle: capture.title,
      contentTitle: capture.content.title,
      wordCount: capture.content.wordCount,
      headings: capture.content.headings.slice(0, MAX_HEADINGS),
      visibleLinks: links,
      meta: capture.data.meta,
      openGraph: capture.data.openGraph,
      content: truncate(content, MAX_FINAL_CONTENT_CHARS)
    },
    null,
    2
  )
}

function describeEvidence(t: Trajectory): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const result of t.steps) {
    const evidence = result.evidence
    if (!evidence || seen.has(evidence.url)) continue
    seen.add(evidence.url)
    lines.push(
      [
        `URL: ${evidence.url}`,
        `TITLE: ${evidence.contentTitle || evidence.title || '(untitled)'}`,
        evidence.wordCount ? `WORDS: ~${evidence.wordCount}` : '',
        evidence.headings.length
          ? `HEADINGS: ${evidence.headings.map((h) => `${'#'.repeat(Math.min(h.level, 6))} ${h.text}`).join(' | ')}`
          : '',
        evidence.links.length
          ? `LINKS: ${evidence.links.map((l) => `[${truncate(l.text, 60)}] ${truncate(l.href, 100)}`).join(' ; ')}`
          : '',
        `TEXT: ${truncate(evidence.text, MAX_EVIDENCE_TEXT_CHARS)}`
      ]
        .filter(Boolean)
        .join('\n')
    )
    if (lines.length >= MAX_EVIDENCE_ITEMS) break
  }
  return lines.length ? lines.join('\n\n---\n\n') : '(No intermediate page evidence was captured.)'
}

function uniqueLinks(capture: PageCapture): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = []
  const seen = new Set<string>()

  for (const action of capture.actions) {
    if (action.role !== 'link' || !action.value) continue
    const key = action.value
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      text: truncate(action.name || action.value, 160),
      href: action.value
    })
    if (out.length >= MAX_LINKS) break
  }

  return out
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}
