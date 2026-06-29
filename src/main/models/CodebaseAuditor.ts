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

  async runAudit(focusPath?: string): Promise<string> {
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

    const systemPrompt = `You are an elite, high-density Codebase Auditing Agent.
Your task is to ingest the repository evidence, bounded source excerpts, and optional focus areas of a workspace, and synthesize an exceptionally clear, deep-dive Markdown architectural report. This report serves as a detailed blueprint for developers and AI models to understand exactly how the system functions, its core interfaces, state management flows, security mechanisms, and the exact files to edit for different features.`;

    const promptSections = [
      `Workspace Root: ${workspaceRoot}`,
      focusPath ? `Audit Focus Target: Only focus on modules, files, and rules related to: "${focusPath}"` : null,
      readme ? `\n=== README.md ===\n${readme}` : '\n=== README.md ===\nNone found',
      `\n=== Repository Overview ===\n${overview.summary}`,
      fileSpans ? `\n=== Key File Spans ===\n${fileSpans}` : '\n=== Key File Spans ===\nNone captured',
      focusContext ? `\n${focusContext}` : null,
      fallbackTree ? `\n=== Complete Project File Tree ===\n${fallbackTree}` : null
    ].filter((part): part is string => Boolean(part));

    const userPrompt = `${promptSections.join('\n')}

Generate an extremely detailed, beautiful, highly structured Markdown report containing:

1. **Core Technology Stack & Configurations**:
   - Comprehensive analysis of frameworks, library versions, and package structure.
   - Deep dive into the build configuration, compile targets, and bundler setups (e.g., Vite/Webpack configs, Preload script bridge setups).

2. **Architecture & Directory Deep-Dive**:
   - Folder-by-folder layout mapping. Explain exactly what lives where and the clean boundaries between modules (e.g. main vs. renderer vs. shared).
   - Describe communication protocols (e.g., Electron IPC channels, HTTP APIs, WebSocket structures) and how they flow across layers.

3. **System Lifecycles, Entry Points & Boot Sequence**:
   - Detail the boot sequence and lifecycles of the application based on the main entry points.
   - Trace how routers are configured, databases/stores are initialized, background agents/workers are spun up, and tabs/sessions are managed.

4. **Detailed Feature/Domain Architecture**:
   - Break down the core domains, specialized mechanisms (such as context caching, state sync, security hooks, file system management, web devtools session, or specific business logic patterns).

5. **Key Types, State Schemas & IPC Protocols**:
   - Document the exact interfaces, state stores, database structures, or IPC contracts discovered in the provided evidence.

6. **Developer Edit Cheat Sheet & Mod Map**:
   - Provide concrete, exact relative file paths for typical engineering tasks (e.g., "To add a new browser automation tool, update X and Y", "To modify the UI layout, update Z").

Output ONLY the final Markdown document. Be rigorous, highly detailed, precise, and ground your report completely in the provided codebase context. Do not include vague generic templates; make it specific to the files, folders, and contents you see.`;

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
