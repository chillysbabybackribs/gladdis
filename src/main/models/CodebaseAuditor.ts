import * as fs from 'fs/promises';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../../../shared/models';
import { snapshotDirectoryTree } from '../fs/repoSnapshot';
import type { BrokerCallContext, CapabilityBroker } from './capabilities/CapabilityBroker';
import { RepoIntelligenceService } from './capabilities/RepoIntelligenceService';

type RepoOverviewPayload = {
  workspaceRoot: string;
  packageManager: string | null;
  packageName: string | null;
  scripts: string[];
  keyFiles: string[];
  topDirectories: string[];
  entryPoints: string[];
  focus?: string;
};

type ReadSpansPayload = {
  workspaceRoot: string;
  items: Array<{
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number | null;
    truncated: boolean;
    defaultWindow: boolean;
    content: string;
  }>;
};

function formatSpanMeta(path: string, startLine: number, endLine: number, totalLines: number | null): string {
  return totalLines == null
    ? `=== ${path} (lines ${startLine}-${endLine}) ===`
    : `=== ${path} (lines ${startLine}-${endLine} of ${totalLines}) ===`;
}

export interface CodebaseAuditorOptions {
  capabilityBroker?: Pick<CapabilityBroker, 'repoOverview' | 'searchRepo' | 'readSpans'>;
  brokerContext?: BrokerCallContext;
  repoIntelligence?: RepoIntelligenceService;
}

type SearchRepoPayload = {
  workspaceRoot: string;
  query: string;
  path?: string;
  glob?: string;
  totalHits: number;
  hits: Array<{
    path: string;
    kind: 'content' | 'path';
    line: number;
    text: string;
  }>;
  suggestedSpans: Array<{
    path: string;
    startLine: number;
    endLine: number;
  }>;
};

/**
 * Models to try (in order) when no explicit model is requested. Picked from
 * {@link MODELS} (provider==='google') and re-ordered from cheapest/fastest to
 * largest. We retry across the chain only when a request fails with what
 * looks like an "unknown model" error (404 / model_not_found / not supported),
 * so a real workload error doesn't get silently masked by the next candidate.
 */
const GOOGLE_MODEL_FALLBACK_CHAIN: string[] = (() => {
  const ordered = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  const known = new Set(MODELS.filter((m) => m.provider === 'google').map((m) => m.id));
  const chain = ordered.filter((id) => known.has(id));
  // If MODELS drifts, fall back to whatever is actually listed for google.
  return chain.length > 0 ? chain : MODELS.filter((m) => m.provider === 'google').map((m) => m.id);
})();

const MODEL_NOT_FOUND_PATTERNS = [
  /model[_\s-]*not[_\s-]*found/i,
  /unknown model/i,
  /not\s+(?:found|supported|available)/i,
  /\b404\b/,
  /\b400\b.*model/i
];

const FOCUS_TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.css',
  '.html',
  '.yaml',
  '.yml'
]);

export class CodebaseAuditor {
  private readonly repoIntelligence: RepoIntelligenceService;
  private readonly capabilityBroker?: Pick<CapabilityBroker, 'repoOverview' | 'searchRepo' | 'readSpans'>;
  private readonly brokerContext?: BrokerCallContext;

  constructor(
    private workspaceRoot: string,
    private ai: GoogleGenAI,
    private modelOverride?: string,
    options: CodebaseAuditorOptions = {}
  ) {
    this.repoIntelligence = options.repoIntelligence ?? new RepoIntelligenceService();
    this.capabilityBroker = options.capabilityBroker;
    this.brokerContext = options.brokerContext;
  }

  /**
   * Recursively scans directories to build a lightweight representation of the project tree.
   * Standard directories like node_modules, .git, build outputs, and lockfiles are skipped.
   * This remains as a fallback for non-brokered audits and focused directory snapshots.
   */
  async scanDirectory(dir: string, depth = 0, maxDepth = 6): Promise<string[]> {
    if (depth > maxDepth) return [];
    return snapshotDirectoryTree(this.workspaceRoot, dir, {
      maxDepth: maxDepth - depth
    });
  }

  async runAudit(focusPath?: string, auditGoal?: string): Promise<string> {
    const workspaceRoot = path.resolve(this.workspaceRoot);
    const overview = await this.loadOverview(workspaceRoot, focusPath);
    const [readme, focusContext, goalEvidence] = await Promise.all([
      this.readOptional(path.join(workspaceRoot, 'README.md'), 1000),
      focusPath ? this.readFocusPathContext(workspaceRoot, focusPath) : Promise.resolve(''),
      this.collectGoalEvidence(workspaceRoot, focusPath, auditGoal)
    ]);

    const fallbackTree =
      this.capabilityBroker ? '' : (await this.scanDirectory(workspaceRoot)).join('\n');

    const systemPrompt = `You are an elite, evidence-first Codebase Auditing Agent.
Your job is to inspect the provided repository evidence, optional focus areas, and the caller's audit goal, then produce a precise Markdown audit that answers that goal directly.

Behavioral requirements:
- Let the audit goal determine the report shape, priorities, and depth.
- Ground every substantive claim in the provided repository evidence.
- Cite concrete file paths for findings and architectural claims whenever possible.
- Separate confirmed findings from uncertainty; explicitly say when evidence is insufficient.
- Classify observations clearly: confirmed findings, strengths, costly-by-design tradeoffs, and needs-more-verification concerns should not be mixed together.
- Avoid falling back to a generic template when the caller asked for something narrower or comparative.
- This is an audit-only analysis task. Do not recommend making edits "as if already done," do not imply tests/validation ran unless the evidence says they ran, and do not drift into implementation narration.
- If no explicit audit goal is provided, produce a balanced general codebase audit.`;

    const promptSections = [
      `Workspace Root: ${workspaceRoot}`,
      focusPath ? `Audit Focus Target: Only focus on modules, files, and rules related to: "${focusPath}"` : null,
      readme ? `\n=== README.md ===\n${readme}` : '\n=== README.md ===\nNone found',
      `\n=== Repository Overview ===\n${overview.summary}`,
      focusContext ? `\n${focusContext}` : null,
      goalEvidence ? `\n=== Goal-Driven Evidence ===\n${goalEvidence}` : null,
      fallbackTree ? `\n=== Complete Project File Tree ===\n${fallbackTree}` : null
    ].filter((part): part is string => Boolean(part));

    const goalText = auditGoal?.trim()
      ? auditGoal.trim()
      : 'Run a general codebase audit and surface the most important findings from the available evidence.';

    const userPrompt = `${promptSections.join('\n')}

=== Audit Goal ===
${goalText}

Write a Markdown audit that directly answers the audit goal above.

Requirements:
- Choose the report structure that best fits the audit goal instead of forcing a fixed template.
- Prioritize the highest-signal findings for that goal.
- Include concrete evidence with file paths for each important claim.
- Use explicit labels for confidence: keep confirmed claims separate from plausible-but-unconfirmed concerns.
- Call out "costly by design" cases separately from true inefficiencies when the code is intentionally paying cost for product behavior.
- Call out strengths as well as weaknesses when the goal asks for them or when they materially affect the conclusion.
- Add a short "Needs More Verification" section for any plausible but unconfirmed concerns.
- If the goal is broad, organize the audit into the most useful sections you can infer from the evidence.

Output ONLY the final Markdown document. Be rigorous, precise, and fully grounded in the provided codebase context.`;

    const candidates = this.modelCandidates();
    const errors: Array<{ model: string; message: string }> = [];
    for (const model of candidates) {
      try {
        const response = await this.ai.models.generateContent({
          model,
          contents: [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Acknowledged. I will produce a grounded, evidence-first audit report.' }] },
            { role: 'user', parts: [{ text: userPrompt }] }
          ],
          config: {
            temperature: 0.1,
          }
        });
        return response.text ?? `Error: Unable to generate codebase audit (model ${model} returned empty).`;
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ model, message });
        if (!isModelNotFoundError(message)) {
          return `Error: codebase audit failed on model ${model}: ${message}`;
        }
      }
    }
    return `Error: codebase audit could not find a working Google model. Tried: ${errors
      .map((e) => `${e.model} (${e.message})`)
      .join(' | ')}`;
  }

  private async loadOverview(
    workspaceRoot: string,
    focusPath?: string
  ): Promise<{ summary: string; structuredPayload: RepoOverviewPayload }> {
    if (this.capabilityBroker && this.brokerContext) {
      const brokerResult = await this.capabilityBroker.repoOverview(this.brokerContext, {
        workspaceRoot,
        ...(focusPath ? { focus: focusPath } : {})
      });
      if (brokerResult.ok && brokerResult.structuredPayload) {
        return {
          summary: brokerResult.summary,
          structuredPayload: brokerResult.structuredPayload as RepoOverviewPayload
        };
      }
    }

    return this.repoIntelligence.repoOverview({
      workspaceRoot,
      ...(focusPath ? { focus: focusPath } : {})
    });
  }

  private async readSpans(workspaceRoot: string, files: string[]): Promise<string> {
    if (files.length === 0) return '';

    const items = files.slice(0, 6).map((filePath) => ({
      path: filePath,
      startLine: 1,
      endLine: 160
    }));

    return this.readSpanItems(workspaceRoot, items);
  }

  private async readSpanItems(
    workspaceRoot: string,
    items: Array<{ path: string; startLine: number; endLine: number }>
  ): Promise<string> {
    if (items.length === 0) return '';

    if (this.capabilityBroker && this.brokerContext) {
      const brokerResult = await this.capabilityBroker.readSpans(this.brokerContext, {
        workspaceRoot,
        items
      });
      if (brokerResult.ok && brokerResult.structuredPayload) {
        return this.formatReadSpans(brokerResult.structuredPayload as ReadSpansPayload);
      }
    }

    const result = await this.repoIntelligence.readSpans({ workspaceRoot, items });
    return this.formatReadSpans(result.structuredPayload);
  }

  private formatReadSpans(payload: ReadSpansPayload): string {
    return payload.items
      .map((item) => {
        const meta = formatSpanMeta(item.path, item.startLine, item.endLine, item.totalLines);
        return `${meta}\n${item.content}`;
      })
      .join('\n\n');
  }

  private async readFocusPathContext(workspaceRoot: string, focusPath: string): Promise<string> {
    const fullPath = this.resolveFocusPath(workspaceRoot, focusPath);
    if (!fullPath) return '[Focus path ignored: it resolves outside the selected workspace root.]';
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        if (FOCUS_TEXT_EXTENSIONS.has(ext)) {
          const result = await this.readSpans(workspaceRoot, [focusPath]);
          return result ? `=== FOCUS FILE CONTENT: ${focusPath} ===\n${result}` : '';
        }
        return '';
      }
      if (stats.isDirectory()) {
        const [snapshot, focusFiles] = await Promise.all([
          this.scanDirectory(fullPath, 0, 2),
          this.listFocusFiles(workspaceRoot, fullPath)
        ]);
        const spans = focusFiles.length > 0 ? await this.readSpans(workspaceRoot, focusFiles) : '';
        const parts = [];
        if (snapshot.length > 0) {
          parts.push(`=== FOCUS DIRECTORY SNAPSHOT: ${focusPath} ===\n${snapshot.join('\n')}`);
        }
        if (spans) {
          parts.push(`=== FOCUS DIRECTORY KEY FILES: ${focusPath} ===\n${spans}`);
        }
        return parts.join('\n\n');
      }
    } catch (err: any) {
      return `[Error loading focus path context: ${err.message}]`;
    }
    return '';
  }

  private async collectGoalEvidence(
    workspaceRoot: string,
    focusPath: string | undefined,
    auditGoal: string | undefined
  ): Promise<string> {
    const goalQuery = this.buildGoalEvidenceQuery(auditGoal);
    if (!goalQuery) return '';

    if (this.capabilityBroker && this.brokerContext) {
      const brokerResult = await this.capabilityBroker.searchRepo(this.brokerContext, {
        workspaceRoot,
        query: goalQuery,
        ...(focusPath ? { path: focusPath } : {}),
        maxResults: 6
      });
      if (brokerResult.ok && brokerResult.structuredPayload) {
        const payload = brokerResult.structuredPayload as SearchRepoPayload;
        const spans = payload.suggestedSpans.length > 0
          ? await this.readSpanItems(
              workspaceRoot,
              payload.suggestedSpans.map((span) => ({
                path: span.path,
                startLine: span.startLine,
                endLine: span.endLine
              }))
            )
          : '';
        return [brokerResult.summary, spans ? `Suggested evidence reads:\n${spans}` : '']
          .filter(Boolean)
          .join('\n\n');
      }
      return brokerResult.summary;
    }

    return '';
  }

  private buildGoalEvidenceQuery(auditGoal: string | undefined): string | null {
    const raw = auditGoal?.trim();
    if (!raw) return null;

    const quotedPhrases = Array.from(raw.matchAll(/"([^"]+)"|'([^']+)'/g))
      .map((match) => (match[1] || match[2] || '').trim())
      .filter((phrase) => phrase.length >= 3);
    if (quotedPhrases.length > 0) return quotedPhrases[0];

    const normalized = raw
      .toLowerCase()
      .replace(/\b(audit|review|inspect|analy[sz]e|check|look\s+for|find)\b/g, ' ')
      .replace(/\b(the|this|that|these|those|codebase|repo|repository|project|code|for|of|in|on|with|and|or|to|now|please)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return null;

    const pathish = normalized.match(/[a-z0-9_./-]{3,}/g) ?? [];
    const meaningful = pathish.filter((token) => token.length >= 4).slice(0, 5);
    if (meaningful.length === 0) return null;
    const cleaned = meaningful.map((token) =>
      token
        .replace(/^[^a-z0-9_./-]+/gi, '')
        .replace(/[.,:;!?]+$/g, '')
        .replace(/[^a-z0-9_./-]+$/gi, '')
    );
    const finalTokens = cleaned.filter((token) => token.length >= 4);
    if (finalTokens.length === 0) return null;
    if (finalTokens.length === 1) return finalTokens[0];
    return finalTokens.slice(0, 3).join(' ');
  }

  private resolveFocusPath(workspaceRoot: string, focusPath: string): string | null {
    const resolved = path.resolve(workspaceRoot, focusPath);
    const relative = path.relative(workspaceRoot, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolved;
    }
    return null;
  }

  private async listFocusFiles(
    workspaceRoot: string,
    fullPath: string,
    maxDepth = 2,
    maxFiles = 4
  ): Promise<string[]> {
    const ignoreDirs = new Set(['node_modules', '.git', '.cache', 'dist', 'out', '.next', 'build']);
    const out: string[] = [];
    const visit = async (dir: string, depth: number) => {
      if (out.length >= maxFiles || depth > maxDepth) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => FOCUS_TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) || name === 'package.json')
        .sort((a, b) => this.focusFileScore(b) - this.focusFileScore(a) || a.localeCompare(b));
      for (const name of files) {
        out.push(path.relative(workspaceRoot, path.join(dir, name)).replace(/\\/g, '/'));
        if (out.length >= maxFiles) return;
      }
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !ignoreDirs.has(entry.name) && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      for (const name of dirs) {
        await visit(path.join(dir, name), depth + 1);
        if (out.length >= maxFiles) return;
      }
    };
    await visit(fullPath, 0);
    return out;
  }

  private focusFileScore(name: string): number {
    if (name === 'package.json') return 100;
    if (name.toLowerCase() === 'readme.md') return 90;
    const ext = path.extname(name).toLowerCase();
    if (ext === '.ts' || ext === '.tsx') return 80;
    if (ext === '.js' || ext === '.jsx') return 70;
    if (ext === '.json') return 60;
    return 40;
  }

  private async readOptional(filePath: string, maxChars: number): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.length > maxChars
        ? content.slice(0, maxChars) + '\n... [truncated for token conservation]'
        : content;
    } catch {
      return '';
    }
  }

  /**
   * Build the ordered list of model IDs to try, with the explicit override
   * (constructor or env) taking precedence and the static fallback chain
   * filling in the rest. De-duplicated, preserves order.
   */
  private modelCandidates(): string[] {
    const candidates: string[] = [];
    const push = (id: string | undefined | null) => {
      if (id && !candidates.includes(id)) candidates.push(id);
    };
    push(this.modelOverride);
    push(process.env.GLADDIS_AUDIT_MODEL);
    for (const id of GOOGLE_MODEL_FALLBACK_CHAIN) push(id);
    return candidates;
  }
}

function isModelNotFoundError(message: string): boolean {
  return MODEL_NOT_FOUND_PATTERNS.some((re) => re.test(message));
}
