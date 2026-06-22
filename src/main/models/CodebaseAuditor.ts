import * as fs from 'fs/promises';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../../../shared/models';

/**
 * Models to try (in order) when no explicit model is requested. Picked from
 * {@link MODELS} (provider==='google') and re-ordered from cheapest/fastest to
 * largest. We retry across the chain only when a request fails with what
 * looks like an "unknown model" error (404 / model_not_found / not supported),
 * so a real workload error doesn't get silently masked by the next candidate.
 */
const GOOGLE_MODEL_FALLBACK_CHAIN: string[] = (() => {
  const ordered = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']
  const known = new Set(MODELS.filter((m) => m.provider === 'google').map((m) => m.id))
  const chain = ordered.filter((id) => known.has(id))
  // If MODELS drifts, fall back to whatever is actually listed for google.
  return chain.length > 0 ? chain : MODELS.filter((m) => m.provider === 'google').map((m) => m.id)
})()

const MODEL_NOT_FOUND_PATTERNS = [
  /model[_\s-]*not[_\s-]*found/i,
  /unknown model/i,
  /not\s+(?:found|supported|available)/i,
  /\b404\b/,
  /\b400\b.*model/i
]

export class CodebaseAuditor {
  constructor(
    private workspaceRoot: string,
    private ai: GoogleGenAI,
    private modelOverride?: string
  ) {}

  /**
   * Recursively scans directories to build a lightweight representation of the project tree.
   * Standard directories like node_modules, .git, build outputs, and lockfiles are skipped.
   */
  async scanDirectory(dir: string, depth = 0, maxDepth = 6): Promise<string[]> {
    if (depth > maxDepth) return [];
    
    const ignored = new Set([
      'node_modules', '.git', '.next', 'dist', 'build', 'out', 
      '.pnpm-store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
      '.svelte-kit', '.nuxt', '.docusaurus', 'coverage', '.cache'
    ]);

    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignored.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(this.workspaceRoot, fullPath);
        
        if (entry.isDirectory()) {
          results.push(`${relativePath}/`);
          const sub = await this.scanDirectory(fullPath, depth + 1, maxDepth);
          results.push(...sub);
        } else {
          results.push(relativePath);
        }
      }
    } catch (err) {
      // Gracefully bypass restricted/unreadable directories
    }
    return results;
  }

  /**
   * Reads key configuration files if they exist in the root of the workspace.
   */
  private async readConfigFiles(): Promise<Record<string, string>> {
    const configsToRead = [
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'electron.vite.config.ts',
      'tailwind.config.js',
      'tailwind.config.ts',
      '.env.example',
      'webpack.config.js',
      'next.config.js'
    ];

    const results: Record<string, string> = {};
    for (const filename of configsToRead) {
      try {
        const fullPath = path.join(this.workspaceRoot, filename);
        const content = await fs.readFile(fullPath, 'utf-8');
        results[filename] = content.length > 5000 
          ? content.slice(0, 5000) + '\n... [truncated for token conservation]'
          : content;
      } catch {
        // Skip if file doesn't exist or is unreadable
      }
    }
    return results;
  }

  /**
   * Reads the first N lines/characters of a file.
   */
  private async readHeadOfFile(filePath: string, maxChars = 4000): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.length > maxChars) {
        return content.slice(0, maxChars) + '\n... [truncated for token conservation]';
      }
      return content;
    } catch {
      return '';
    }
  }

  /**
   * Discovers and reads the first part of crucial entry files.
   */
  private async readEntryPoints(): Promise<Record<string, string>> {
    const entriesToFind = [
      'src/main/index.ts',
      'src/main.ts',
      'src/index.ts',
      'src/preload/index.ts',
      'src/preload.ts',
      'src/renderer/src/main.tsx',
      'src/renderer/main.tsx',
      'src/renderer/index.tsx',
      'src/renderer/App.tsx',
      'src/App.tsx'
    ];

    const results: Record<string, string> = {};
    for (const relPath of entriesToFind) {
      const fullPath = path.join(this.workspaceRoot, relPath);
      try {
        const content = await this.readHeadOfFile(fullPath, 3000);
        if (content) {
          results[relPath] = content;
        }
      } catch {}
    }
    return results;
  }

  /**
   * Reads source code context around the focusPath if specified.
   */
  private async readFocusPathContext(focusPath: string): Promise<string> {
    const fullPath = path.resolve(this.workspaceRoot, focusPath);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isFile()) {
        const content = await this.readHeadOfFile(fullPath, 15000);
        return `=== FOCUS FILE CONTENT: ${focusPath} ===\n${content}`;
      } else if (stats.isDirectory()) {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        let combined = `=== FOCUS DIRECTORY FILES in ${focusPath} ===\n`;
        let count = 0;
        for (const entry of entries) {
          if (entry.isFile() && count < 10) {
            const ext = path.extname(entry.name);
            const textExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html', '.yaml', '.yml'];
            if (textExtensions.includes(ext.toLowerCase())) {
              const fileRelPath = path.join(focusPath, entry.name);
              const fileFullPath = path.join(fullPath, entry.name);
              const content = await this.readHeadOfFile(fileFullPath, 3000);
              if (content) {
                combined += `\n--- File: ${fileRelPath} ---\n${content}\n`;
                count++;
              }
            }
          }
        }
        return combined;
      }
    } catch (err: any) {
      return `[Error loading focus path context: ${err.message}]`;
    }
    return '';
  }

  async runAudit(focusPath?: string): Promise<string> {
    const fileTree = await this.scanDirectory(this.workspaceRoot);
    const configFiles = await this.readConfigFiles();
    const entryPoints = await this.readEntryPoints();

    let focusContext = '';
    if (focusPath) {
      focusContext = await this.readFocusPathContext(focusPath);
    }

    let readme = '';
    try {
      readme = await fs.readFile(path.join(this.workspaceRoot, 'README.md'), 'utf-8');
      if (readme.length > 5000) {
        readme = readme.slice(0, 5000) + '\n... [truncated for token conservation]';
      }
    } catch {}

    const systemPrompt = `You are an elite, high-density Codebase Auditing Agent.
Your task is to ingest the file structure, configuration files, primary entry points, and optional focus areas of a workspace, and synthesize an exceptionally clear, deep-dive Markdown architectural report. This report serves as a detailed blueprint for developers and AI models to understand exactly how the system functions, its core interfaces, state management flows, security mechanisms, and the exact files to edit for different features.`;

    // Format configs and entries for the prompt
    let configsBlock = '';
    for (const [name, content] of Object.entries(configFiles)) {
      configsBlock += `\n=== CONFIG: ${name} ===\n${content}\n`;
    }

    let entriesBlock = '';
    for (const [name, content] of Object.entries(entryPoints)) {
      entriesBlock += `\n=== ENTRY POINT: ${name} ===\n${content}\n`;
    }

    const userPrompt = `
Here is the raw context of the project codebase:
Workspace Root: ${this.workspaceRoot}
${focusPath ? `Audit Focus Target: Only focus on modules, files, and rules related to: "${focusPath}"` : ''}

=== README.md ===
${readme || 'None found'}
${configsBlock}
${entriesBlock}
${focusContext ? `\n${focusContext}\n` : ''}

=== Complete Project File Tree ===
${fileTree.join('\n')}

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
   - Document the exact interfaces, state stores, database structures, or IPC contracts discovered in the entry points, configuration files, or types.

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
          // A real error (network, quota, permission) — surface it instead of
          // silently sliding to the next candidate.
          return `Error: codebase audit failed on model ${model}: ${message}`;
        }
      }
    }
    return `Error: codebase audit could not find a working Google model. Tried: ${errors
      .map((e) => `${e.model} (${e.message})`)
      .join(' | ')}`;
  }

  /**
   * Build the ordered list of model IDs to try, with the explicit override
   * (constructor or env) taking precedence and the static fallback chain
   * filling in the rest. De-duplicated, preserves order.
   */
  private modelCandidates(): string[] {
    const candidates: string[] = []
    const push = (id: string | undefined | null) => {
      if (id && !candidates.includes(id)) candidates.push(id)
    }
    push(this.modelOverride)
    push(process.env.GLADDIS_AUDIT_MODEL)
    for (const id of GOOGLE_MODEL_FALLBACK_CHAIN) push(id)
    return candidates
  }
}

function isModelNotFoundError(message: string): boolean {
  return MODEL_NOT_FOUND_PATTERNS.some((re) => re.test(message))
}
