import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const sourceRoot = path.resolve(import.meta.dirname, '../browser')

async function sourceFiles(directory = sourceRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      files.push(entryPath)
  }
  return files
}

function resolveLocalImport(
  from: string,
  specifier: string,
  knownFiles: ReadonlySet<string>
): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/, ''))
  for (const extension of ['.ts', '.tsx']) {
    const candidate = `${base}${extension}`
    if (candidate.startsWith(sourceRoot) && knownFiles.has(candidate))
      return candidate
  }
  return null
}

async function localImportGraph(): Promise<Map<string, string[]>> {
  const files = await sourceFiles()
  const knownFiles = new Set(files)
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const imports: string[] = []
    const recordImport = (specifier: string): void => {
      const resolved = resolveLocalImport(file, specifier, knownFiles)
      if (resolved) imports.push(resolved)
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        recordImport(node.moduleSpecifier.text)
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        recordImport(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    graph.set(file, imports)
  }
  return graph
}

function reaches(
  graph: Map<string, string[]>,
  start: string,
  target: string
): boolean {
  const pending = [start]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current === target) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(graph.get(current) ?? []))
  }
  return false
}

test('route modules do not create a dependency cycle through App', async () => {
  const graph = await localImportGraph()
  const app = path.join(sourceRoot, 'app', 'App.tsx')
  const memoryPage = path.join(sourceRoot, 'features', 'memory', 'Memory.tsx')
  const routeModules = graph.get(app) ?? []
  const memoryModules = [...graph.keys()].filter((file) =>
    file.startsWith(path.join(sourceRoot, 'features', 'memory'))
  )

  assert.ok(routeModules.length > 0)
  assert.ok(memoryModules.length > 0)
  assert.equal(reaches(graph, app, memoryPage), true)
  for (const module of routeModules) {
    assert.equal(
      reaches(graph, module, app),
      false,
      `${path.basename(module)} must not depend on App.tsx`
    )
  }
  for (const module of memoryModules) {
    assert.equal(
      reaches(graph, module, app),
      false,
      `${path.basename(module)} must not depend on App.tsx`
    )
  }
})

test('feature domains depend inward through explicit shared capabilities', async () => {
  const graph = await localImportGraph()
  const sharedRoot = path.join(sourceRoot, 'shared')
  const runsRoot = path.join(sourceRoot, 'features', 'runs')
  const memoryRoot = path.join(sourceRoot, 'features', 'memory')

  for (const [file, imports] of graph) {
    if (file.startsWith(sharedRoot)) {
      for (const imported of imports) {
        assert.equal(
          imported.startsWith(runsRoot) || imported.startsWith(memoryRoot),
          false,
          `${path.relative(sourceRoot, file)} must not depend on a feature domain`
        )
      }
    }
    if (file.startsWith(runsRoot)) {
      for (const imported of imports) {
        assert.equal(
          imported.startsWith(memoryRoot),
          false,
          `${path.relative(sourceRoot, file)} must not depend on memory`
        )
      }
    }
    if (file.startsWith(memoryRoot)) {
      for (const imported of imports) {
        assert.equal(
          imported.startsWith(runsRoot),
          false,
          `${path.relative(sourceRoot, file)} must not depend on runs`
        )
      }
    }
  }
})
