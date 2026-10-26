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
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const AXIS_STORES = [
  'preparation-store.ts',
  'publication-store.ts',
  'execution-store.ts'
] as const

/** The modules `file` imports, normalized to the `.ts` basename used by `AXIS_STORES`.
 *
 * Sources import the compiled specifier (`.js`), so the extension is rewritten rather than
 * compared literally: comparing against the source extension is what made an earlier version of
 * this check pass no matter what was imported.
 */
function importedModules(file: string): string[] {
  const source = readFileSync(path.join(SRC, file), 'utf8')
  return [...source.matchAll(/^import[\s\S]*?from '(\.[^']+)'/gm)].map(
    (match) => path.basename(match[1] ?? '').replace(/\.js$/, '.ts')
  )
}

test('single-axis stores do not depend on each other', () => {
  for (const store of AXIS_STORES) {
    const dependencies = importedModules(store)
    for (const other of AXIS_STORES) {
      if (other === store) continue
      assert.ok(
        !dependencies.includes(other),
        `${store} imports ${other}; a cross-axis write shared by two axes belongs in its own module so the stores stay independent`
      )
    }
    // `review-store.ts` constructs the stores, so it must not be imported back.
    assert.ok(
      !dependencies.includes('review-store.ts'),
      `${store} imports review-store.ts, which constructs it`
    )
  }
})
