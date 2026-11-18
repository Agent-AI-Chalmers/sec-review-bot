// The coordination code is split by lifecycle axis, and the split only means something if the
// single-axis stores do not import each other. Nothing else enforces that: the compiler is happy
// with a cyclic import, and the previous round did briefly make `preparation-store` depend on
// `publication-store` to reuse one UPDATE. Shared cross-axis writes belong in a small module that
// both import, so the dependency graph stays one-directional.
//
// Parse import and re-export declarations to check direct module dependencies.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import ts from 'typescript'

const SRC = path.resolve(import.meta.dirname, '../src')
const AXIS_STORES = [
  'persistence/preparation-store.ts',
  'persistence/publication-store.ts',
  'persistence/execution-store.ts'
] as const

/** The modules `file` imports, normalized to the `.ts` basename used by `AXIS_STORES`.
 *
 * Sources import the compiled specifier (`.js`), so the extension is rewritten rather than
 * compared literally: comparing against the source extension is what made an earlier version of
 * this check pass no matter what was imported.
 */
function importedModules(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(SRC, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const modules: string[] = []
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      continue
    const specifier = statement.moduleSpecifier
    if (
      specifier &&
      ts.isStringLiteral(specifier) &&
      specifier.text.startsWith('.')
    )
      modules.push(path.basename(specifier.text).replace(/\.js$/, '.ts'))
  }
  return modules
}

test('single-axis stores do not depend on each other', () => {
  for (const store of AXIS_STORES) {
    const dependencies = importedModules(store)
    for (const other of AXIS_STORES) {
      if (other === store) continue
      const otherName = path.basename(other)
      expect(
        dependencies,
        `${store} imports ${otherName}; a cross-axis write shared by two axes belongs in its own module so the stores stay independent`
      ).not.toContain(otherName)
    }
    // `review-run-store.ts` constructs the stores, so it must not be imported back.
    expect(
      dependencies,
      `${store} imports review-run-store.ts, which constructs it`
    ).not.toContain('review-run-store.ts')
  }
})

test('the process entry, HTTP surface, and runtime composition stay acyclic', () => {
  const entry = importedModules('server.ts')
  const surface = importedModules('http/server-surface.ts')
  const runtime = importedModules('runtime/server-runtime.ts')

  expect(entry).toContain('server-runtime.ts')
  expect(runtime).toContain('server-surface.ts')
  expect(runtime).not.toContain('server.ts')
  expect(surface).not.toContain('server.ts')
  expect(surface).not.toContain('server-runtime.ts')

  for (const handler of [
    'http/read-route-handlers.ts',
    'http/coordination-route-handlers.ts',
    'http/admin-route-handlers.ts'
  ]) {
    const dependencies = importedModules(handler)
    expect(dependencies).not.toContain('server.ts')
    expect(dependencies).not.toContain('server-surface.ts')
    expect(dependencies).not.toContain('server-runtime.ts')
  }
})

test('operator decisions compose axis stores without creating a dependency cycle', () => {
  const dependencies = importedModules('persistence/operator-decision-store.ts')
  expect.assert(dependencies.includes('preparation-store.ts') === false)
  expect(dependencies).toContain('publication-store.ts')
  expect(dependencies).toContain('execution-store.ts')
  expect(dependencies).not.toContain('review-run-store.ts')

  for (const store of AXIS_STORES) {
    expect(
      importedModules(store),
      `${store} imports the cross-axis operator decision store`
    ).not.toContain('operator-decision-store.ts')
  }
})

test('the read model does not depend on write stores', () => {
  const dependencies = importedModules('persistence/review-run-queries.ts')
  expect(dependencies).toContain('run-record-projection.ts')
  expect(dependencies).toContain('review-run-events.ts')
  expect(dependencies).not.toContain('review-run-store.ts')
  for (const store of AXIS_STORES) {
    expect(
      dependencies,
      `review-run-queries.ts imports write store ${store}`
    ).not.toContain(path.basename(store))
  }
})

test('submission transitions compose axes without depending on axis stores', () => {
  const dependencies = importedModules(
    'persistence/submission-transition-store.ts'
  )
  expect(dependencies).toContain('publication-abandon.ts')
  expect(dependencies).toContain('review-run-events.ts')
  expect(dependencies).toContain('run-notices.ts')
  expect(dependencies).not.toContain('review-run-store.ts')
  for (const store of AXIS_STORES) {
    expect(
      dependencies,
      `submission-transition-store.ts imports axis store ${store}`
    ).not.toContain(path.basename(store))
  }
})

test('publication claims stay separate from single-axis publication writes', () => {
  const dependencies = importedModules('persistence/publication-claim-store.ts')
  expect(dependencies).toContain('run-record-projection.ts')
  expect(dependencies).toContain('review-run-events.ts')
  expect(dependencies).not.toContain('publication-store.ts')
  expect(dependencies).not.toContain('review-run-store.ts')
})

test('run admission owns aggregate creation without importing axis stores', () => {
  const dependencies = importedModules(
    'persistence/review-run-admission-store.ts'
  )
  expect(dependencies).toContain('run-record-projection.ts')
  expect(dependencies).toContain('review-run-events.ts')
  expect(dependencies).not.toContain('review-run-store.ts')
  for (const store of AXIS_STORES) {
    expect(
      dependencies,
      `review-run-admission-store.ts imports axis store ${store}`
    ).not.toContain(path.basename(store))
  }
})
