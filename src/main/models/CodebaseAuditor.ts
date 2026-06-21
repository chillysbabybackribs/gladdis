import * as fs from 'fs/promises';
import * as path from 'path';
import { GoogleGenAI } from '@google/genai';

export class CodebaseAuditor {
  constructor(private workspaceRoot: string, private ai: GoogleGenAI) {}

  /**
   * Recursively scans directories to build a lightweight representation of the project tree.
   * Standard directories like node_modules, .git, build outputs, and lockfiles are skipped.
   */
  async scanDirectory(dir: string, depth = 0, maxDepth = 4): Promise<string[]> {
    if (depth > maxDepth) return [];
    
    const ignored = new Set([
      'node_modules', '.git', '.next', 'dist', 'build', 'out', 
      '.pnpm-store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'
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

  async runAudit(focusPath?: string): Promise<string> {
    const fileTree = await this.scanDirectory(this.workspaceRoot);
    
    // Read key structural configuration files
    let packageJson = '';
    try {
      packageJson = await fs.readFile(path.join(this.workspaceRoot, 'package.json'), 'utf-8');
    } catch {}

    let tsConfig = '';
    try {
      tsConfig = await fs.readFile(path.join(this.workspaceRoot, 'tsconfig.json'), 'utf-8');
    } catch {}

    let readme = '';
    try {
      readme = await fs.readFile(path.join(this.workspaceRoot, 'README.md'), 'utf-8');
      if (readme.length > 5000) {
        readme = readme.slice(0, 5000) + '\n... [truncated for token conservation]';
      }
    } catch {}

    const systemPrompt = `You are an elite, high-density Codebase Auditing Agent. 
Your task is to ingest the raw file structure, README, package configurations, and TS configs of a workspace, and synthesize an exceptionally clear, highly detailed Markdown guide. This guide is used by other AI models to instantly understand where modules are located, what the technology stack is, and where they should make modifications.`;

    const userPrompt = `
Here is the raw context of the project codebase:
Workspace Root: ${this.workspaceRoot}
${focusPath ? `Audit Focus Target: Only focus on modules, files, and rules related to: "${focusPath}"` : ''}

=== README.md ===
${readme || 'None found'}

=== package.json ===
${packageJson || 'None found'}

=== tsconfig.json ===
${tsConfig || 'None found'}

=== Complete Project File Tree ===
${fileTree.join('\n')}

Generate a dense, beautiful Markdown report containing:
1. **Core Technology Stack**: Direct breakdown of technologies, frameworks, and patterns used.
2. **Architecture & Directory Map**: What lives in key folders (e.g., main process, UI renderer, shared schemas).
3. **Primary Entry Points & Flow**: Where does execution start, how are routers initialized, and where are background workers bound?
4. **Developer Edit Cheat Sheet**:
   - If I want to edit frontend components, I should edit: [paths]
   - If I want to add/edit background tool handlers, I should edit: [paths]
   - If I want to modify types or configurations, I should edit: [paths]
5. **Key Types / Central Schemas**: Where are domain entities or state definitions located?

Output ONLY the final Markdown document. Be concise and prioritize accuracy over filler text.`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.1,
      }
    });

    return response.text ?? 'Error: Unable to generate codebase audit.';
  }
}
