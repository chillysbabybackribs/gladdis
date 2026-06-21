import { describe, it, expect, vi } from 'vitest';
import { CodebaseAuditor } from './CodebaseAuditor';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('CodebaseAuditor', () => {
  it('scans directory recursively and ignores node_modules and dot files', async () => {
    const mockWorkspace = path.join(__dirname, 'mock-workspace-audit-test');
    
    // Create mock directory structures
    await fs.mkdir(mockWorkspace, { recursive: true });
    await fs.mkdir(path.join(mockWorkspace, 'src'), { recursive: true });
    await fs.mkdir(path.join(mockWorkspace, 'node_modules'), { recursive: true });
    
    await fs.writeFile(path.join(mockWorkspace, 'README.md'), '# Mock Project');
    await fs.writeFile(path.join(mockWorkspace, 'package.json'), '{"name": "mock-project"}');
    await fs.writeFile(path.join(mockWorkspace, 'src', 'index.ts'), 'console.log("hello");');
    await fs.writeFile(path.join(mockWorkspace, 'node_modules', 'bad.js'), 'dont-scan-me');

    const mockAi = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: '# Simulated Codebase Audit Report\nSuccessfully mapped.'
        })
      }
    };

    const auditor = new CodebaseAuditor(mockWorkspace, mockAi as any);
    
    const scanned = await auditor.scanDirectory(mockWorkspace);
    
    // Scanned should contain README.md, package.json, and src/index.ts, but not node_modules or node_modules/bad.js
    expect(scanned).toContain('README.md');
    expect(scanned).toContain('package.json');
    expect(scanned).toContain('src/');
    expect(scanned).toContain('src/index.ts');
    expect(scanned).not.toContain('node_modules/');
    expect(scanned).not.toContain('node_modules/bad.js');

    const report = await auditor.runAudit();
    expect(report).toBe('# Simulated Codebase Audit Report\nSuccessfully mapped.');
    expect(mockAi.models.generateContent).toHaveBeenCalled();

    // Cleanup mock folders
    await fs.rm(mockWorkspace, { recursive: true, force: true });
  });
});
