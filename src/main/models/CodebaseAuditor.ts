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
    totalLines: number;
    truncated: boolean;
    defaultWindow: boolean;
    content: string;
  }>;
};

export interface CodebaseAuditorOptions {
  capabilityBroker?: Pick<CapabilityBroker, 'repoOverview' | 'readSpans'>;
  brokerContext?: BrokerCallContext;
  repoIntelligence?: RepoIntelligenceService;
}

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
  private readonly capabilityBroker?: Pick<CapabilityBroker, 'repoOverview' | 'readSpans'>;
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
    const auditFiles = this.pickAuditFiles(overview.structuredPayload);
    const [readme, fileSpans, focusContext] = await Promise.all([
      this.readOptional(path.join(workspaceRoot, 'README.md'), 5000),
      this.readSpans(workspaceRoot, auditFiles),
      focusPath ? this.readFocusPathContext(workspaceRoot, focusPath) : Promise.resolve('')
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
- Avoid falling back to a generic template when the caller asked for something narrower or comparative.
- If no explicit audit goal is provided, produce a balanced general codebase audit.`;

    const promptSections = [
      `Workspace Root: ${workspaceRoot}`,
      focusPath ? `Audit Focus Target: Only focus on modules, files, and rules related to: "${focusPath}"` : null,
      readme ? `\n=== README.md ===\n${readme}` : '\n=== README.md ===\nNone found',
      `\n=== Repository Overview ===\n${overview.summary}`,
      fileSpans ? `\n=== Key File Spans ===\n${fileSpans}` : '\n=== Key File Spans ===\nNone captured',
      focusContext ? `\n${focusContext}` : null,
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
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: systemPrompt,
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
        const meta = `=== ${item.path} (lines ${item.startLine}-${item.endLine} of ${item.totalLines}) ===`;
        return `${meta}\n${item.content}`;
      })
      .join('\n\n');
  }

  private pickAuditFiles(overview: RepoOverviewPayload): string[] {
    const seen = new Set<string>();
    const ordered = [...overview.keyFiles, ...overview.entryPoints].filter((filePath) => {
      if (seen.has(filePath)) return false;
      seen.add(filePath);
      return true;
    });
    return ordered.slice(0, 6);
  }

  private async readFocusPathContext(workspaceRoot: string, focusPath: string): Promise<string> {
    const fullPath = path.resolve(workspaceRoot, focusPath);
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
        const snapshot = await this.scanDirectory(fullPath, 0, 2);
        if (snapshot.length === 0) return '';
        return `=== FOCUS DIRECTORY SNAPSHOT: ${focusPath} ===\n${snapshot.join('\n')}`;
      }
    } catch (err: any) {
      return `[Error loading focus path context: ${err.message}]`;
    }
    return '';
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
