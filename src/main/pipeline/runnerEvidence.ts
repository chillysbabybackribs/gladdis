import type { Condition, PipelineDeps, PlanStep, StepEvidence } from './types'
import { shouldCaptureEvidence, truncate } from './runnerHelpers'

const EVIDENCE_TEXT_CHARS = 1_200
const EVIDENCE_HEADINGS = 12
const EVIDENCE_LINKS = 12

/**
 * Snapshot the live page into a Trajectory-shaped StepEvidence record so
 * downstream consumers (chat-side trace, transcripts) can reason about
 * what the agent actually saw without re-running CDP.
 *
 * We dedupe on URL via `seenUrls` so navigating in/out of the same page
 * doesn't bloat the trajectory; we only keep evidence for steps that
 * actually changed user-visible state (`shouldCaptureEvidence`).
 */
export async function captureEvidence(
  deps: PipelineDeps,
  tabId: string,
  step: PlanStep,
  postCond: Condition,
  seenUrls: Set<string>,
  onLog?: (msg: string) => void
): Promise<StepEvidence | undefined> {
  if (!shouldCaptureEvidence(step, postCond)) return undefined
  try {
    const cap = await deps.capture(tabId)
    if (!cap.url || seenUrls.has(cap.url)) return undefined
    seenUrls.add(cap.url)
    const text = (cap.content?.markdown || cap.content?.text || '').trim()
    const links: Array<{ text: string; href: string }> = []
    const seenLinks = new Set<string>()
    for (const action of cap.actions ?? []) {
      if (action.role !== 'link' || !action.value || seenLinks.has(action.value)) continue
      seenLinks.add(action.value)
      links.push({
        text: truncate(action.name || action.value, 100),
        href: truncate(action.value, 180)
      })
      if (links.length >= EVIDENCE_LINKS) break
    }
    return {
      url: cap.url,
      title: cap.title,
      contentTitle: cap.content?.title,
      wordCount: cap.content?.wordCount,
      text: truncate(text, EVIDENCE_TEXT_CHARS),
      headings: (cap.content?.headings ?? []).slice(0, EVIDENCE_HEADINGS),
      links
    }
  } catch (e: any) {
    onLog?.(`⚠️ [Runner] Evidence capture skipped: ${e?.message ?? e}`)
    return undefined
  }
}
