import * as fs from 'fs/promises'
import type { Dirent } from 'fs'
import * as path from 'path'
import ts from 'typescript'

export interface RepoIndexSymbol {
  name: string
  kind: string
  line: number
  endLine: number
}

export interface RepoIndexFile {
  path: string
  hash: string
  bytes: number
  imports: string[]
  exports: string[]
  symbols: RepoIndexSymbol[]
}

export interface RepoIndexSnapshot {
  version: 1
  workspaceRoot: string
  builtAt: number
  files: RepoIndexFile[]
}

export interface RepoIndexSearchInput {
  workspaceRoot: string
  query: string
  path?: string
  glob?: string
  maxResults?: number
}

export interface RepoIndexSearchHit {
  path: string
  kind: 'symbol' | 'export' | 'import' | 'path'
  line: number
  text: string
}

export interface RepoIndexRelatedInput {
  workspaceRoot: string
  paths: string[]
  query?: string
  maxResults?: number
}

export interface RepoIndexRelatedFile {
  path: string
  reason: string
}

const INDEX_VERSION = 1
const INDEX_DIR = path.join('.gladdis', 'repo-intel')
const INDEX_FILE = 'index-v1.json'
const MAX_INDEXED_FILE_BYTES = 512 * 1024
const MAX_FILES_PER_BUILD = 5000
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const IGNORE_DIRS = new Set([
  '.git',
  '.gladdis',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache'
])

interface WorkspaceState {
  snapshot?: RepoIndexSnapshot
  warmPromise?: Promise<void>
}

export class RepoIndexService {
  private readonly workspaces = new Map<string, WorkspaceState>()

  warm(workspaceRoot: string): void {
    const root = path.resolve(workspaceRoot)
    const state = this.stateFor(root)
    if (state.warmPromise) return
    state.warmPromise = this.rebuild(root)
      .then((snapshot) => {
        state.snapshot = snapshot
      })
      .catch((err) => {
        console.warn('[repo-index] warm failed:', err)
      })
      .finally(() => {
        state.warmPromise = undefined
      })
  }

  async refresh(workspaceRoot: string): Promise<RepoIndexSnapshot> {
    const root = path.resolve(workspaceRoot)
    const snapshot = await this.rebuild(root)
    this.stateFor(root).snapshot = snapshot
    return snapshot
  }

  async search(input: RepoIndexSearchInput): Promise<RepoIndexSearchHit[]> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const query = input.query.trim()
    if (!query) return []

    const snapshot = await this.snapshotIfReady(workspaceRoot)
    if (!snapshot) return []

    const maxResults = Math.min(50, Math.max(1, input.maxResults ?? 8))
    const scope = normalizeScope(input.path)
    const queryLower = query.toLowerCase()
    const hits: Array<RepoIndexSearchHit & { score: number }> = []

    for (const file of snapshot.files) {
      if (scope && !isInScope(file.path, scope)) continue
      if (input.glob && !matchesGlob(path.basename(file.path), input.glob)) continue

      if (file.path.toLowerCase().includes(queryLower)) {
        hits.push({ path: file.path, kind: 'path', line: 1, text: file.path, score: scoreText(file.path, queryLower, 20) })
      }
      for (const symbol of file.symbols) {
        const haystack = `${symbol.name} ${symbol.kind}`.toLowerCase()
        if (!haystack.includes(queryLower)) continue
        hits.push({
          path: file.path,
          kind: 'symbol',
          line: symbol.line,
          text: `${symbol.kind} ${symbol.name}`,
          score: scoreText(symbol.name, queryLower, 80)
        })
      }
      for (const name of file.exports) {
        if (!name.toLowerCase().includes(queryLower)) continue
        const symbol = file.symbols.find((candidate) => candidate.name === name)
        hits.push({
          path: file.path,
          kind: 'export',
          line: symbol?.line ?? 1,
          text: `export ${name}`,
          score: scoreText(name, queryLower, 70)
        })
      }
      for (const imported of file.imports) {
        if (!imported.toLowerCase().includes(queryLower)) continue
        hits.push({
          path: file.path,
          kind: 'import',
          line: 1,
          text: `import ${imported}`,
          score: scoreText(imported, queryLower, 45)
        })
      }
    }

    return hits
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
      .slice(0, maxResults)
      .map(({ score: _score, ...hit }) => hit)
  }

  async relatedFiles(input: RepoIndexRelatedInput): Promise<RepoIndexRelatedFile[]> {
    const workspaceRoot = path.resolve(input.workspaceRoot)
    const snapshot = await this.snapshotIfReady(workspaceRoot)
    if (!snapshot) return []

    const maxResults = Math.min(20, Math.max(1, input.maxResults ?? 6))
    const fileSet = new Set(snapshot.files.map((file) => file.path))
    const seeds = new Set(
      input.paths
        .map((filePath) => normalizeRelPath(filePath))
        .filter((filePath) => filePath && fileSet.has(filePath))
    )
    if (seeds.size === 0) return []

    const byPath = new Map(snapshot.files.map((file) => [file.path, file]))
    const queryLower = input.query?.trim().toLowerCase() || ''
    const related = new Map<string, RepoIndexRelatedFile & { score: number }>()

    for (const seed of seeds) {
      const seedFile = byPath.get(seed)
      if (!seedFile) continue
      for (const specifier of seedFile.imports) {
        const resolved = resolveLocalImport(seed, specifier, fileSet)
        if (!resolved || seeds.has(resolved)) continue
        const candidate = byPath.get(resolved)
        if (!candidate) continue
        upsertRelated(related, {
          path: resolved,
          reason: `imported by ${seed}`,
          score: 70 + scoreRelatedFile(candidate, queryLower)
        })
      }
    }

    for (const file of snapshot.files) {
      if (seeds.has(file.path)) continue
      const importsSeed = file.imports.some((specifier) => {
        const resolved = resolveLocalImport(file.path, specifier, fileSet)
        return Boolean(resolved && seeds.has(resolved))
      })
      if (importsSeed) {
        upsertRelated(related, {
          path: file.path,
          reason: `imports ${[...seeds].join(', ')}`,
          score: 50 + scoreRelatedFile(file, queryLower)
        })
      }
    }

    return [...related.values()]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxResults)
      .map(({ score: _score, ...file }) => file)
  }

  private async snapshotIfReady(workspaceRoot: string): Promise<RepoIndexSnapshot | null> {
    const state = this.stateFor(workspaceRoot)
    if (state.snapshot) return state.snapshot
    const persisted = await this.readPersisted(workspaceRoot)
    if (persisted) {
      state.snapshot = persisted
      this.warm(workspaceRoot)
      return persisted
    }
    return null
  }

  private async rebuild(workspaceRoot: string): Promise<RepoIndexSnapshot> {
    const files = await listSourceFiles(workspaceRoot)
    const indexed: RepoIndexFile[] = []
    for (const relPath of files.slice(0, MAX_FILES_PER_BUILD)) {
      const absPath = path.join(workspaceRoot, relPath)
      try {
        const stat = await fs.stat(absPath)
        if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) continue
        const content = await fs.readFile(absPath, 'utf8')
        indexed.push(indexFile(relPath, content, stat.size))
      } catch {
        // Files can disappear during background indexing; skip and keep moving.
      }
    }
    const snapshot: RepoIndexSnapshot = {
      version: INDEX_VERSION,
      workspaceRoot,
      builtAt: Date.now(),
      files: indexed
    }
    await this.writePersisted(workspaceRoot, snapshot)
    return snapshot
  }

  private async readPersisted(workspaceRoot: string): Promise<RepoIndexSnapshot | null> {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, INDEX_DIR, INDEX_FILE), 'utf8')
      const parsed = JSON.parse(raw) as RepoIndexSnapshot
      if (parsed.version !== INDEX_VERSION || parsed.workspaceRoot !== workspaceRoot || !Array.isArray(parsed.files)) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  private async writePersisted(workspaceRoot: string, snapshot: RepoIndexSnapshot): Promise<void> {
    const dir = path.join(workspaceRoot, INDEX_DIR)
    await fs.mkdir(dir, { recursive: true })
    const tmp = path.join(dir, `${INDEX_FILE}.tmp`)
    const dest = path.join(dir, INDEX_FILE)
    await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8')
    await fs.rename(tmp, dest)
  }

  private stateFor(workspaceRoot: string): WorkspaceState {
    let state = this.workspaces.get(workspaceRoot)
    if (!state) {
      state = {}
      this.workspaces.set(workspaceRoot, state)
    }
    return state
  }
}

async function listSourceFiles(workspaceRoot: string): Promise<string[]> {
  const results: string[] = []
  async function walk(absDir: string, relDir: string): Promise<void> {
    if (results.length >= MAX_FILES_PER_BUILD) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (results.length >= MAX_FILES_PER_BUILD) return
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        await walk(path.join(absDir, entry.name), path.join(relDir, entry.name))
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(path.join(relDir, entry.name).split(path.sep).join('/'))
      }
    }
  }
  await walk(workspaceRoot, '')
  return results
}

function indexFile(relPath: string, content: string, bytes: number): RepoIndexFile {
  const source = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, scriptKindForPath(relPath))
  const imports = new Set<string>()
  const exports = new Set<string>()
  const symbols: RepoIndexSymbol[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text)
    }

    const symbol = symbolFromNode(node, source)
    if (symbol) {
      symbols.push(symbol)
      if (hasExportModifier(node)) exports.add(symbol.name)
    }

    if (ts.isExportAssignment(node)) exports.add('default')
    ts.forEachChild(node, visit)
  }
  visit(source)

  return {
    path: relPath,
    hash: hashText(content),
    bytes,
    imports: [...imports].sort(),
    exports: [...exports].sort(),
    symbols: symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
  }
}

function symbolFromNode(node: ts.Node, source: ts.SourceFile): RepoIndexSymbol | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    const name = node.name?.text
    if (!name) return null
    return symbolWithRange(name, syntaxKindLabel(node.kind), node, source)
  }
  if (ts.isVariableStatement(node)) {
    const first = node.declarationList.declarations[0]
    if (!first || !ts.isIdentifier(first.name)) return null
    return symbolWithRange(first.name.text, 'variable', node, source)
  }
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
    if (!ts.isIdentifier(node.name)) return null
    return symbolWithRange(node.name.text, ts.isMethodDeclaration(node) ? 'method' : 'property', node, source)
  }
  return null
}

function symbolWithRange(name: string, kind: string, node: ts.Node, source: ts.SourceFile): RepoIndexSymbol {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  return { name, kind, line: start, endLine: end }
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword))
}

function syntaxKindLabel(kind: ts.SyntaxKind): string {
  switch (kind) {
    case ts.SyntaxKind.FunctionDeclaration:
      return 'function'
    case ts.SyntaxKind.ClassDeclaration:
      return 'class'
    case ts.SyntaxKind.InterfaceDeclaration:
      return 'interface'
    case ts.SyntaxKind.TypeAliasDeclaration:
      return 'type'
    case ts.SyntaxKind.EnumDeclaration:
      return 'enum'
    default:
      return 'symbol'
  }
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function normalizeScope(scope?: string): string | null {
  const clean = scope?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return clean && clean !== '.' ? clean : null
}

function normalizeRelPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

function isInScope(filePath: string, scope: string): boolean {
  return filePath === scope || filePath.startsWith(`${scope}/`)
}

function matchesGlob(fileName: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(fileName)
}

function resolveLocalImport(fromPath: string, specifier: string, fileSet: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null
  const fromDir = path.posix.dirname(fromPath)
  const base = path.posix.normalize(path.posix.join(fromDir, specifier))
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => path.posix.join(base, `index${extension}`))
  ]
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null
}

function upsertRelated(
  related: Map<string, RepoIndexRelatedFile & { score: number }>,
  candidate: RepoIndexRelatedFile & { score: number }
): void {
  const existing = related.get(candidate.path)
  if (!existing || candidate.score > existing.score) {
    related.set(candidate.path, candidate)
  }
}

function scoreRelatedFile(file: RepoIndexFile, queryLower: string): number {
  if (!queryLower) return 0
  let score = 0
  if (file.path.toLowerCase().includes(queryLower)) score = Math.max(score, scoreText(file.path, queryLower, 20))
  for (const exported of file.exports) {
    if (exported.toLowerCase().includes(queryLower)) {
      score = Math.max(score, scoreText(exported, queryLower, 40))
    }
  }
  for (const symbol of file.symbols) {
    const haystack = `${symbol.name} ${symbol.kind}`.toLowerCase()
    if (haystack.includes(queryLower)) {
      score = Math.max(score, scoreText(symbol.name, queryLower, 45))
    }
  }
  return score
}

function scoreText(value: string, queryLower: string, base: number): number {
  const lower = value.toLowerCase()
  if (lower === queryLower) return base + 30
  if (lower.startsWith(queryLower)) return base + 20
  return base + Math.max(0, 10 - lower.indexOf(queryLower))
}

function hashText(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
