// The coordination code is split by lifecycle axis, and the split only means something if the
// single-axis stores do not import each other. Nothing else enforces that: the compiler is happy
// with a cyclic import, and the previous round did briefly make `preparation-store` depend on
// `publication-store` to reuse one UPDATE. Shared cross-axis writes belong in a small module that
// both import, so the dependency graph stays one-directional.
//
// This is a dependency check, not a source-text check: it reads each module's own import
// statements to prove which files it depends on.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

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
  const source = readFileSync(path.join(SRC, file), 'utf8')
  return [
    ...source.matchAll(/^(?:import|export)[\s\S]*?from '(\.[^']+)'/gm)
  ].map((match) => path.basename(match[1] ?? '').replace(/\.js$/, '.ts'))
}

test('single-axis stores do not depend on each other', () => {
  for (const store of AXIS_STORES) {
    const dependencies = importedModules(store)
    for (const other of AXIS_STORES) {
      if (other === store) continue
      const otherName = path.basename(other)
      assert.ok(
        !dependencies.includes(otherName),
        `${store} imports ${otherName}; a cross-axis write shared by two axes belongs in its own module so the stores stay independent`
      )
    }
    // `review-run-store.ts` constructs the stores, so it must not be imported back.
    assert.ok(
      !dependencies.includes('review-run-store.ts'),
      `${store} imports review-run-store.ts, which constructs it`
    )
  }
})

test('the process entry, HTTP surface, and runtime composition stay acyclic', () => {
  const entry = importedModules('server.ts')
  const surface = importedModules('http/server-surface.ts')
  const runtime = importedModules('runtime/server-runtime.ts')

  assert.ok(entry.includes('server-surface.ts'))
  assert.ok(entry.includes('server-runtime.ts'))
  assert.ok(runtime.includes('server-surface.ts'))
  assert.ok(!runtime.includes('server.ts'))
  assert.ok(!surface.includes('server.ts'))
  assert.ok(!surface.includes('server-runtime.ts'))

  for (const handler of [
    'http/read-route-handlers.ts',
    'http/coordination-route-handlers.ts',
    'http/admin-route-handlers.ts'
  ]) {
    const dependencies = importedModules(handler)
    assert.ok(!dependencies.includes('server.ts'))
    assert.ok(!dependencies.includes('server-surface.ts'))
    assert.ok(!dependencies.includes('server-runtime.ts'))
  }
})

test('operator decisions compose axis stores without creating a dependency cycle', () => {
  const dependencies = importedModules('persistence/operator-decision-store.ts')
  assert.ok(dependencies.includes('preparation-store.ts') === false)
  assert.ok(dependencies.includes('publication-store.ts'))
  assert.ok(dependencies.includes('execution-store.ts'))
  assert.ok(!dependencies.includes('review-run-store.ts'))

  for (const store of AXIS_STORES) {
    assert.ok(
      !importedModules(store).includes('operator-decision-store.ts'),
      `${store} imports the cross-axis operator decision store`
    )
  }
})

test('the read model does not depend on write stores', () => {
  const dependencies = importedModules('persistence/review-run-queries.ts')
  assert.ok(dependencies.includes('run-record-projection.ts'))
  assert.ok(dependencies.includes('review-run-events.ts'))
  assert.ok(!dependencies.includes('review-run-store.ts'))
  for (const store of AXIS_STORES) {
    assert.ok(
      !dependencies.includes(path.basename(store)),
      `review-run-queries.ts imports write store ${store}`
    )
  }
})

test('submission transitions compose axes without depending on axis stores', () => {
  const dependencies = importedModules(
    'persistence/submission-transition-store.ts'
  )
  assert.ok(dependencies.includes('publication-abandon.ts'))
  assert.ok(dependencies.includes('review-run-events.ts'))
  assert.ok(dependencies.includes('run-notices.ts'))
  assert.ok(!dependencies.includes('review-run-store.ts'))
  for (const store of AXIS_STORES) {
    assert.ok(
      !dependencies.includes(path.basename(store)),
      `submission-transition-store.ts imports axis store ${store}`
    )
  }
})

test('publication claims stay separate from single-axis publication writes', () => {
  const dependencies = importedModules('persistence/publication-claim-store.ts')
  assert.ok(dependencies.includes('run-record-projection.ts'))
  assert.ok(dependencies.includes('review-run-events.ts'))
  assert.ok(!dependencies.includes('publication-store.ts'))
  assert.ok(!dependencies.includes('review-run-store.ts'))
})

test('run admission owns aggregate creation without importing axis stores', () => {
  const dependencies = importedModules(
    'persistence/review-run-admission-store.ts'
  )
  assert.ok(dependencies.includes('run-record-projection.ts'))
  assert.ok(dependencies.includes('review-run-events.ts'))
  assert.ok(!dependencies.includes('review-run-store.ts'))
  for (const store of AXIS_STORES) {
    assert.ok(
      !dependencies.includes(path.basename(store)),
      `review-run-admission-store.ts imports axis store ${store}`
    )
  }
})
