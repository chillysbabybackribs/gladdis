/**
 * Dream pipeline dry-run.
 *
 * Runs the FULL Dreamer end-to-end (sampling → extract → reconcile → verify
 * → persist → diff) against a fresh temp workspace, with a stubbed LLM. Zero
 * API spend, no Electron, no real conversations needed — just the pipeline
 * doing its work and writing a memory.next.json + memory.next.diff.json you
 * can open and read.
 *
 * Usage:
 *   npx tsx scripts/dream-dry-run.ts
 *   npx tsx scripts/dream-dry-run.ts --keep    # don't auto-delete the temp dir
 *   npx tsx scripts/dream-dry-run.ts --scope=24h
 *   npx tsx scripts/dream-dry-run.ts --auto    # run via runAuto + auto-adopt path
 *
 * What you see in stdout:
 *   • Progress events streaming live (started → stage → done)
 *   • A formatted summary of the diff (counts + first row of each action)
 *   • The path to the temp workspace so you can inspect the artifacts
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { Dreamer } from '../src/main/models/memory/Dreamer'
import type { ChatStore } from '../src/main/models/ChatStore'
import type {
  Conversation,
  ConversationMeta,
  DreamProgressEvent,
  DreamScope,
  KeyStatus
} from '../shared/types'

const args = new Set(process.argv.slice(2))
const KEEP = args.has('--keep')
const AUTO = args.has('--auto')
const SCOPE = (Array.from(args).find((a) => a.startsWith('--scope='))?.split('=')[1] ?? '7d') as DreamScope

// ── synthetic conversations the dreamer will read ─────────────────────────
const NOW = Date.now()
const HOUR = 3_600_000

const CONVERSATIONS: Conversation[] = [
  {
    id: 'conv-prefs-1',
    title: 'TypeScript discussion',
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    messages: [
      { role: 'user', text: 'I always prefer TypeScript over plain JS for new projects. Stricter types catch bugs earlier.' },
      { role: 'assistant', text: 'Got it — TypeScript-first.' },
      { role: 'user', text: 'Also, I like 2-space indents and never want trailing semicolons.' },
      { role: 'assistant', text: 'Noted.' }
    ]
  },
  {
    id: 'conv-stack-1',
    title: 'Project setup',
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    messages: [
      { role: 'user', text: 'Build the React app with Vite 6 and Vitest 4 — that is the project standard.' },
      { role: 'assistant', text: 'Scaffolded with Vite 6 + Vitest 4.' },
      { role: 'user', text: 'Yeah, we use electron-vite 5 for the desktop bundle, same convention.' }
    ]
  },
  {
    id: 'conv-decisions-1',
    title: 'Auth decisions',
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 3 * HOUR,
    messages: [
      { role: 'user', text: 'We decided on JWT for the auth flow, not session cookies. Cleaner for the SPA front.' },
      { role: 'assistant', text: 'JWT it is.' },
      { role: 'user', text: 'Make sure refresh tokens are HttpOnly cookies — best of both worlds.' }
    ]
  },
  {
    id: 'conv-caveats-1',
    title: 'Migration warnings',
    createdAt: NOW - 4 * HOUR,
    updatedAt: NOW - 4 * HOUR,
    messages: [
      { role: 'user', text: 'Heads up: never run `npm install` in /tmp — our CI clears it mid-step and the lockfile breaks.' },
      { role: 'assistant', text: 'Will avoid that path.' }
    ]
  }
]

// ── fake ChatStore that just answers list()/get() ─────────────────────────
const fakeChats: ChatStore = {
  list: () =>
    CONVERSATIONS.map<ConversationMeta>((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    })),
  get: (id: string) => CONVERSATIONS.find((c) => c.id === id) ?? null
} as unknown as ChatStore

// ── stubbed model: returns canned candidates for extract, supported for verify ─
const EXTRACT_RESPONSE = JSON.stringify({
  candidates: [
    {
      kind: 'preference',
      scope: 'workspace',
      text: 'user prefers TypeScript over JavaScript for new projects',
      evidence: [
        { conversationId: 'conv-prefs-1', messageIndex: 0, turnExcerpt: 'I always prefer TypeScript over plain JS' }
      ],
      tags: ['language', 'style'],
      confidence: 0.92
    },
    {
      kind: 'preference',
      scope: 'workspace',
      text: 'user prefers 2-space indents with no trailing semicolons',
      evidence: [
        { conversationId: 'conv-prefs-1', messageIndex: 2, turnExcerpt: '2-space indents and never want trailing semicolons' }
      ],
      tags: ['style'],
      confidence: 0.88
    },
    {
      kind: 'project-fact',
      scope: 'workspace',
      text: 'project uses Vite 6, Vitest 4, and electron-vite 5',
      evidence: [
        { conversationId: 'conv-stack-1', messageIndex: 0, turnExcerpt: 'Build the React app with Vite 6 and Vitest 4' },
        { conversationId: 'conv-stack-1', messageIndex: 2, turnExcerpt: 'we use electron-vite 5 for the desktop bundle' }
      ],
      tags: ['stack'],
      confidence: 0.95
    },
    {
      kind: 'decision',
      scope: 'workspace',
      text: 'auth uses JWT for SPA, with refresh tokens stored as HttpOnly cookies',
      evidence: [
        { conversationId: 'conv-decisions-1', messageIndex: 0, turnExcerpt: 'We decided on JWT for the auth flow' },
        { conversationId: 'conv-decisions-1', messageIndex: 2, turnExcerpt: 'refresh tokens are HttpOnly cookies' }
      ],
      tags: ['auth'],
      confidence: 0.9
    },
    {
      kind: 'caveat',
      scope: 'workspace',
      text: 'avoid running `npm install` in /tmp — CI clears it mid-step and corrupts the lockfile',
      evidence: [
        { conversationId: 'conv-caveats-1', messageIndex: 0, turnExcerpt: 'never run `npm install` in /tmp' }
      ],
      tags: ['ci', 'gotcha'],
      confidence: 0.8
    },
    // A low-confidence + thin-evidence row that the deterministic reconciler should REJECT.
    {
      kind: 'pattern',
      scope: 'workspace',
      text: 'user might prefer dark mode',
      evidence: [{ conversationId: 'conv-prefs-1', messageIndex: 1 }],
      tags: [],
      confidence: 0.35
    },
    // A confidently-stated but BOGUS claim — the deterministic engine will
    // ADD it (high confidence, plausible-looking evidence), but the review
    // stage gets to flag it because the evidence excerpt does not actually
    // support the claim.
    {
      kind: 'decision',
      scope: 'workspace',
      text: 'project will switch from Node to Deno next quarter',
      evidence: [
        { conversationId: 'conv-stack-1', messageIndex: 0, turnExcerpt: 'Build the React app with Vite 6 and Vitest 4' }
      ],
      tags: ['stack'],
      confidence: 0.88
    }
  ]
})

// Review stage: stubbed model decides to (a) tighten one preference's wording
// and (b) reject the Deno hallucination. Confirms everything else.
const REVIEW_RESPONSE = JSON.stringify({
  overrides: [
    {
      candidateIndex: 1,
      action: 'add',
      newText: 'user prefers 2-space indentation and no trailing semicolons',
      reason: 'tightened wording, same meaning'
    },
    {
      candidateIndex: 6,
      action: 'reject',
      reason: 'evidence excerpt is about Vite/Vitest, not Deno — claim is unsupported'
    }
  ]
})

// Hygiene stage: stubbed model archives the obviously-stale seeded entry and
// demotes another. The actual entryIds are unknown statically, so the prompt
// inspector below extracts them on the fly.
const VERIFY_RESPONSE = JSON.stringify({
  verifications: [
    { entryId: 'will-be-overridden', verdict: 'supported', reason: 'cited in transcript' }
  ]
})

function makeHygieneResponse(promptText: string): string {
  // The hygiene prompt lists entries as "[mem_xxx] kind=... scope=...".
  // Pick the first up to two ids and craft decisions against them.
  const ids = Array.from(promptText.matchAll(/\[(mem_[a-z0-9_]+)\]/gi)).map((m) => m[1])
  if (ids.length === 0) return JSON.stringify({ decisions: [] })

  const decisions: Array<Record<string, unknown>> = [
    {
      entryId: ids[0],
      action: 'archive',
      reason: 'stale and never reinforced — replaced by a newer entry this dream'
    }
  ]
  if (ids.length > 1) {
    decisions.push({
      entryId: ids[1],
      action: 'demote',
      newConfidence: 0.4,
      reason: 'evidence is thin and the claim has not been restated in months'
    })
  }
  return JSON.stringify({ decisions })
}

const fakeComplete = async (
  _modelId: string,
  system: string,
  user: string
): Promise<string> => {
  // Mimic real latency so the progress events visibly tick through stages.
  await new Promise((r) => setTimeout(r, 300))
  if (system.includes('fact-checker')) return VERIFY_RESPONSE
  if (system.includes('reviewing a deterministic memory reconciler')) return REVIEW_RESPONSE
  if (system.includes('curator of a long-lived memory store')) return makeHygieneResponse(user)
  return EXTRACT_RESPONSE
}

const KEYED: KeyStatus = {
  anthropic: false,
  google: false,
  codex: true, // picks the cheapest path → a codex model id (no real call, fakeComplete stubs it)
  openai: false,
  grok: false
}

// ── seed pre-existing memory so we can see merges + hygiene in action ─────
async function seedWorkspace(workspaceRoot: string): Promise<void> {
  const dir = join(workspaceRoot, '.gladdis')
  await mkdir(dir, { recursive: true })
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
  const preExisting = {
    version: 2,
    workspace: { root: workspaceRoot, updatedAt: new Date().toISOString() },
    entries: [
      // Will be MERGED with the TypeScript extract candidate (similarity ≥ 0.65).
      {
        id: 'mem_seed_typescript',
        kind: 'preference',
        scope: 'workspace',
        workspaceRoot,
        text: 'team prefers TypeScript over JavaScript',
        evidence: [{ conversationId: 'conv-old', messageIndex: 0 }],
        confidence: 0.7,
        freshness: { createdAt: daysAgo(30), lastReinforcedAt: daysAgo(30) },
        tags: ['language']
      },
      // Stale + thin evidence + low confidence — prime hygiene archive target.
      {
        id: 'mem_seed_stale_router',
        kind: 'project-fact',
        scope: 'workspace',
        workspaceRoot,
        text: 'project uses Express 4 with a custom session middleware',
        evidence: [],
        confidence: 0.45,
        freshness: { createdAt: daysAgo(180), lastReinforcedAt: daysAgo(180) },
        tags: ['legacy']
      },
      // Medium age, medium confidence — hygiene-eligible but plausibly worth keeping.
      {
        id: 'mem_seed_overconfident',
        kind: 'caveat',
        scope: 'workspace',
        workspaceRoot,
        text: 'old caveat: never deploy on Fridays',
        evidence: [{ conversationId: 'conv-very-old' }],
        confidence: 0.78,
        freshness: { createdAt: daysAgo(90), lastReinforcedAt: daysAgo(90) },
        tags: []
      },
      // Older than the triage age floor — also a hygiene target.
      {
        id: 'mem_seed_abandoned_tool',
        kind: 'playbook',
        scope: 'workspace',
        workspaceRoot,
        text: 'to roll a release, run the legacy Gulp pipeline by hand',
        evidence: [],
        confidence: 0.35,
        freshness: { createdAt: daysAgo(240), lastReinforcedAt: daysAgo(240) },
        tags: ['stale']
      }
    ],
    tasks: {}
  }
  await writeFile(join(dir, 'memory.json'), JSON.stringify(preExisting, null, 2), 'utf8')
}

// ── run ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'gladdis-dream-dry-'))
  console.log(`\n📁 Temp workspace: ${workspace}\n`)
  await seedWorkspace(workspace)

  const startTs = Date.now()
  const dreamer = new Dreamer({
    chats: fakeChats,
    complete: fakeComplete,
    getKeyStatus: () => KEYED,
    emitProgress: (event: DreamProgressEvent) => {
      const t = ((Date.now() - startTs) / 1000).toFixed(2).padStart(5, ' ')
      if (event.type === 'started') {
        console.log(`[${t}s] ▶  started — model=${event.modelProvider}:${event.modelId} scope=${event.scope}`)
      } else if (event.type === 'stage') {
        const detail = event.detail ? ` — ${event.detail}` : ''
        console.log(`[${t}s] ·  ${event.stage}${detail}`)
      } else {
        const status = event.ok ? '✓' : '✗'
        const error = event.error ? ` (${event.error})` : ''
        console.log(`[${t}s] ${status}  done${error}`)
      }
    }
  })

  const result = AUTO
    ? await dreamer.runAuto(
        { workspaceRoot: workspace, scope: SCOPE, preferenceOrder: 'cheapest' },
        'strict'
      )
    : await dreamer.run({
        workspaceRoot: workspace,
        scope: SCOPE,
        preferenceOrder: 'cheapest'
      })

  console.log('')
  if (!result.ok) {
    console.error(`✗ Dream failed: ${result.error}`)
    process.exit(1)
  }

  if (AUTO) {
    const adopted = (result as { autoAdopted?: boolean }).autoAdopted === true
    const reason = (result as { autoAdoptReason?: string }).autoAdoptReason
    const errorMsg = (result as { autoAdoptError?: string }).autoAdoptError
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━ AUTO-ADOPT PATH ━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`Adopted automatically: ${adopted ? 'yes' : 'no'}`)
    if (!adopted && reason) console.log(`  ↳ reason: ${reason}`)
    if (errorMsg) console.log(`  ↳ adopt error: ${errorMsg}`)
    console.log('')
  }

  const diff = result.diff
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━ DREAM SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`Sessions sampled:  ${diff.sampledSessionCount}`)
  console.log(`Model:             ${diff.modelProvider}:${diff.modelId}`)
  console.log(`Added:             ${diff.summary.added}`)
  console.log(`Merged:            ${diff.summary.merged}`)
  console.log(`Replaced:          ${diff.summary.replaced}`)
  console.log(`Rejected:          ${diff.summary.rejected}`)
  console.log(`Archived:          ${diff.summary.archived}`)
  console.log(`Demoted:           ${diff.summary.demoted}`)
  console.log(`Reinforced:        ${diff.summary.reinforced}`)
  console.log(`Unchanged:         ${diff.summary.unchanged}`)
  console.log('')

  for (const action of ['add', 'merge', 'replace', 'reject'] as const) {
    const rows = diff.entries.filter((e) => e.action === action)
    if (rows.length === 0) continue
    console.log(`━ ${action.toUpperCase()} (${rows.length}) ━`)
    for (const r of rows) {
      console.log(`  · [${r.kind}] ${r.text}`)
      if (r.previousText) console.log(`      was: ${r.previousText}`)
      if (r.reason) console.log(`      ↳ ${r.reason}`)
    }
    console.log('')
  }

  for (const action of ['archive', 'demote', 'reinforce', 'keep'] as const) {
    const rows = (diff.hygiene ?? []).filter((h) => h.action === action)
    if (rows.length === 0) continue
    console.log(`━ HYGIENE • ${action.toUpperCase()} (${rows.length}) ━`)
    for (const r of rows) {
      console.log(`  · [${r.kind}] ${r.text}`)
      if (r.previousText) console.log(`      was: ${r.previousText}`)
      if (
        r.previousConfidence !== undefined &&
        Math.abs(r.previousConfidence - r.confidence) >= 0.005
      ) {
        console.log(`      c=${r.previousConfidence.toFixed(2)} → ${r.confidence.toFixed(2)}`)
      }
      if (r.reason) console.log(`      ↳ ${r.reason}`)
    }
    console.log('')
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━ ARTIFACTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  const memoryPath = join(workspace, '.gladdis', 'memory.json')
  const candidatePath = join(workspace, '.gladdis', 'memory.next.json')
  const diffPath = join(workspace, '.gladdis', 'memory.next.diff.json')
  console.log(`memory.json:           ${memoryPath}`)
  console.log(`memory.next.json:      ${candidatePath}`)
  console.log(`memory.next.diff.json: ${diffPath}`)
  console.log('')

  // Show a peek of whichever file the run produced. After auto-adopt the
  // candidate is consumed and only memory.json remains; surface that
  // distinction so the dry-run output reflects reality.
  const inspectionPath = await firstReadable([candidatePath, memoryPath])
  if (inspectionPath) {
    const contents = await readFile(inspectionPath, 'utf8')
    const parsed = JSON.parse(contents) as { entries: unknown[] }
    const label = inspectionPath === candidatePath ? 'Candidate' : 'Live memory (post-adopt)'
    console.log(`${label} has ${parsed.entries.length} entries. First entry:`)
    console.log(JSON.stringify(parsed.entries[0] ?? null, null, 2).split('\n').map((l) => `  ${l}`).join('\n'))
  }

  // Always show a dream-history peek so the user can see the rolling log.
  const historyPath = join(workspace, '.gladdis', 'dream-history.json')
  try {
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as { entries: unknown[] }
    console.log(`\nDream history: ${history.entries.length} entry/entries at ${historyPath}`)
  } catch {
    /* no history written (failure path) — leave silent */
  }

  if (!KEEP) {
    await rm(workspace, { recursive: true, force: true })
    console.log(`\n(temp workspace cleaned up; pass --keep to inspect manually)`)
  } else {
    console.log(`\n(kept on disk — open with: cd ${workspace})`)
  }
}

async function firstReadable(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await readFile(p, 'utf8')
      return p
    } catch {
      /* try the next */
    }
  }
  return null
}

main().catch((err) => {
  console.error('Dry-run crashed:', err)
  process.exit(1)
})
