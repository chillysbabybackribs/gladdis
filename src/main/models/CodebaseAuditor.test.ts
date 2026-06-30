import { describe, expect, it, vi } from 'vitest';
import { CodebaseAuditor } from './CodebaseAuditor';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('CodebaseAuditor', () => {
  it('scans directory recursively and ignores node_modules and dot files', async () => {
    const mockWorkspace = path.join(__dirname, 'mock-workspace-audit-test');

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

    expect(scanned).toContain('README.md');
    expect(scanned).toContain('package.json');
    expect(scanned).toContain('src/');
    expect(scanned).toContain('src/index.ts');
    expect(scanned).not.toContain('node_modules/');
    expect(scanned).not.toContain('node_modules/bad.js');

    const report = await auditor.runAudit();
    expect(report).toBe('# Simulated Codebase Audit Report\nSuccessfully mapped.');
    expect(mockAi.models.generateContent).toHaveBeenCalled();

    const firstCall = vi.mocked(mockAi.models.generateContent).mock.calls[0]?.[0];
    expect(firstCall?.contents?.[0]?.parts?.[0]?.text).toContain("Let the audit goal determine the report shape");
    expect(firstCall?.contents?.[0]?.parts?.[0]?.text).toContain('This is an audit-only analysis task.');
    expect(firstCall?.contents?.[2]?.parts?.[0]?.text).toContain('=== Audit Goal ===');
    expect(firstCall?.contents?.[2]?.parts?.[0]?.text).toContain('Run a general codebase audit');
    expect(firstCall?.contents?.[2]?.parts?.[0]?.text).not.toContain('=== Key File Spans ===');
    expect(firstCall?.contents?.[0]?.parts?.[0]?.text).not.toContain('Core Technology Stack & Configurations');

    await fs.rm(mockWorkspace, { recursive: true, force: true });
  });

  it('prefers capability broker evidence over a standalone full-tree scan', async () => {
    const mockWorkspace = path.join(__dirname, 'mock-workspace-audit-broker-test');
    await fs.mkdir(path.join(mockWorkspace, 'src', 'main'), { recursive: true });
    await fs.writeFile(path.join(mockWorkspace, 'README.md'), '# Brokered Project');

    const mockAi = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: '# Simulated Brokered Audit Report'
        })
      }
    };

    const capabilityBroker = {
      repoOverview: vi.fn().mockResolvedValue({
        ok: true,
        summary: 'Workspace: brokered\nKey files: package.json, src/main/index.ts',
        structuredPayload: {
          workspaceRoot: mockWorkspace,
          packageManager: 'npm',
          packageName: 'brokered-project',
          scripts: ['test'],
          keyFiles: ['package.json', 'src/main/index.ts'],
          topDirectories: ['src'],
          entryPoints: ['src/main/index.ts']
        },
        cacheStatus: 'miss'
      }),
      searchRepo: vi.fn().mockResolvedValue({
        ok: true,
        summary: 'Search query: inefficient systems place\nPath: src/main\nHits:\nsrc/main/index.ts:1 - export const boot = true',
        structuredPayload: {
          workspaceRoot: mockWorkspace,
          query: 'inefficient systems place',
          path: 'src/main',
          totalHits: 1,
          hits: [
            {
              path: 'src/main/index.ts',
              kind: 'content',
              line: 1,
              text: 'export const boot = true'
            }
          ],
          suggestedSpans: [
            {
              path: 'src/main/index.ts',
              startLine: 1,
              endLine: 10
            }
          ]
        },
        cacheStatus: 'miss'
      }),
      readSpans: vi.fn().mockResolvedValue({
        ok: true,
        summary: 'unused',
        structuredPayload: {
          workspaceRoot: mockWorkspace,
          items: [
            {
              path: 'src/main/index.ts',
              startLine: 1,
              endLine: 10,
              totalLines: 10,
              truncated: false,
              defaultWindow: false,
              content: 'export const boot = true'
            }
          ]
        },
        cacheStatus: 'miss'
      })
    };

    const auditor = new CodebaseAuditor(mockWorkspace, mockAi as any, undefined, {
      capabilityBroker: capabilityBroker as any,
      brokerContext: {
        requestId: 'req-audit',
        taskId: 'task-audit'
      }
    });
    const scanSpy = vi.spyOn(auditor, 'scanDirectory');

    const report = await auditor.runAudit('src/main', 'Audit the codebase for inefficient systems in place.');

    expect(report).toBe('# Simulated Brokered Audit Report');
    expect(capabilityBroker.repoOverview).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-audit', taskId: 'task-audit' }),
      expect.objectContaining({ workspaceRoot: mockWorkspace, focus: 'src/main' })
    );
    expect(capabilityBroker.searchRepo).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-audit', taskId: 'task-audit' }),
      expect.objectContaining({
        workspaceRoot: mockWorkspace,
        path: 'src/main',
        query: 'inefficient systems place',
        maxResults: 6
      })
    );
    expect(capabilityBroker.readSpans).toHaveBeenCalled();
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(scanSpy).toHaveBeenCalledWith(path.join(mockWorkspace, 'src', 'main'), 0, 2);

    const firstCall = vi.mocked(mockAi.models.generateContent).mock.calls[0]?.[0];
    expect(firstCall?.contents?.[2]?.parts?.[0]?.text).toContain('Audit the codebase for inefficient systems in place.');
    expect(firstCall?.contents?.[2]?.parts?.[0]?.text).toContain('Audit Focus Target: Only focus on modules, files, and rules related to: "src/main"');
    expect(firstCall?.contents?.[2]?.parts?.[0]?.text).toContain('=== Goal-Driven Evidence ===');

    await fs.rm(mockWorkspace, { recursive: true, force: true });
  });
});
