// Every committed artifact derived from a contract must match a fresh render of it.
//
// The check itself lives in one place — `scripts/check-generated-artifacts.ts`, driven by
// `contracts/generated-artifacts.json` — and this asserts through it, so the test and the
// standalone CI entry cannot disagree about what "fresh" means. When a projection is stale
// the message names the file and the command that regenerates it.
//
// The three projections used to restate this comparison in their own test files, each
// reading a path it also had to keep in step; consolidating them means a new projection is
// covered by being added to the manifest, not by remembering to write another test.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  REPO_ROOT,
  readManifest,
  staleGeneratedArtifacts,
  type Manifest
} from '../scripts/check-generated-artifacts.js'
import { GENERATORS } from '../scripts/check-generated-artifacts.js'

test('every contract-derived artifact matches a fresh render', async () => {
  const stale = await staleGeneratedArtifacts()
  assert.deepEqual(
    stale,
    [],
    `these are stale:\n${stale.map((s) => `  ${s.output} -> ${s.command}`).join('\n')}`
  )
})

/** The outputs each generator writes, relative to the repository root, taken from the
 * generators' own `generatedArtifacts()` — the authority the manifest is checked against.
 * Derived from the checker's registry so there is one name-to-generator map, not two. */
const ACTUAL_OUTPUTS: Record<string, string[]> = Object.fromEntries(
  Object.entries(GENERATORS).map(([name, artifacts]) => [
    name,
    artifacts().map((artifact) => path.relative(REPO_ROOT, artifact.output))
  ])
)

test('every generator in the manifest lists exactly the artifacts it writes', () => {
  const manifest: Manifest = readManifest()
  const byName = new Map(manifest.generators.map((g) => [g.name, g.outputs]))

  assert.deepEqual(
    [...byName.keys()].sort(),
    Object.keys(ACTUAL_OUTPUTS).sort(),
    'the manifest lists a different set of generators than the code has'
  )
  for (const [name, outputs] of Object.entries(ACTUAL_OUTPUTS)) {
    assert.deepEqual(
      [...(byName.get(name) ?? [])].sort(),
      [...outputs].sort(),
      `manifest outputs for ${name} do not match the generator`
    )
  }
})

test('every file the manifest names exists', () => {
  // A listed path that does not exist means the manifest is stale or the generator moved;
  // either way the CI filter it drives would be wrong.
  for (const generator of readManifest().generators) {
    for (const output of generator.outputs) {
      assert.doesNotThrow(
        () => readFileSync(path.join(REPO_ROOT, output), 'utf8'),
        `${output} is listed in the manifest but cannot be read`
      )
    }
  }
})

/** Does any glob in `patterns` cover `filePath`? Supports the `**` and `*` forms the CI
 * filter uses; exact strings count as matching themselves. */
function globCovers(patterns: string[], filePath: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === filePath) return true
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**` spans `/`, `*` does not. The \uE000 placeholder (private-use, never in a path)
    // keeps the two substitutions from interfering.
    const regex = new RegExp(
      '^' +
        escaped
          .replace(/\*\*/g, '\uE000')
          .replace(/\*/g, '[^/]*')
          .replace(/\uE000/g, '.*') +
        '$'
    )
    return regex.test(filePath)
  })
}

test('the control-plane CI filter triggers on every generated artifact', () => {
  // The check runs in the control-plane job (and as its own step), so its change filter has
  // to fire for any hand edit of any artifact — including the ones in other packages.
  // Deriving the required set from the manifest keeps that list from silently missing a file
  // (as it did before: the github-integration projection was not listed, so a hand edit of
  // it ran no job that could detect the drift).
  const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const lines = ci.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'control-plane:')
  assert.notEqual(start, -1, 'control-plane filter not found in ci.yml')
  const indent = (lines[start] ?? '').match(/^\s*/)?.[0].length ?? 0

  const patterns: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0
    if (line.trim() !== '' && lineIndent <= indent && !line.trim().startsWith('#')) break
    const match = line.match(/^\s*-\s*'([^']+)'\s*$/)
    if (match?.[1] !== undefined) patterns.push(match[1])
  }
  assert.ok(patterns.length > 0, 'no patterns parsed for the control-plane filter')

  const required = readManifest().generators.flatMap((generator) => generator.outputs)
  for (const output of required) {
    assert.ok(
      globCovers(patterns, output),
      `the control-plane CI filter does not cover ${output}; a hand edit of it would run no ` +
        'job that detects the drift'
    )
  }
})
