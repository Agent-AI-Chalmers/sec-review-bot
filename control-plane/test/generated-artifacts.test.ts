// The generated-artifacts manifest must match what the generators actually write.
//
// `contracts/generated-artifacts.json` is the single list of "what is derived from a
// hand-written contract, and where it lands". CI derives its change filters from it, and
// people use it to find a projection. If it drifts from the generators it guards nothing,
// so this asserts the manifest's paths equal the generators' own exported paths — the
// manifest and the code check each other, rather than each being trusted alone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CONTRACT_TYPES_PATH,
  ERROR_CODES_PATH,
  LIST_RUN_QUERY_PARAMS_PATH,
  OUTPUT_PATH as CONTROL_PLANE_API_TYPES_PATH
} from '../scripts/generate-control-plane-types.js'
import { SCHEMA_DIR, SCHEMA_FILENAMES } from '../scripts/generate-control-plane-schemas.js'
import { OUTPUT_PATH as RUNNER_API_SCHEMA_PATH } from '../scripts/generate-runner-api-types.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MANIFEST_PATH = path.join(REPO_ROOT, 'contracts', 'generated-artifacts.json')

interface Manifest {
  generators: Array<{ name: string; outputs: string[] }>
}

/** The outputs each generator writes, relative to the repository root, taken from the
 * generator's own exports — the authority the manifest is checked against. */
const ACTUAL_OUTPUTS: Record<string, string[]> = {
  'control-plane-types': [
    CONTRACT_TYPES_PATH,
    ERROR_CODES_PATH,
    CONTROL_PLANE_API_TYPES_PATH,
    LIST_RUN_QUERY_PARAMS_PATH
  ].map((p) => path.relative(REPO_ROOT, p)),
  'control-plane-schemas': SCHEMA_FILENAMES.map((name) =>
    path.relative(REPO_ROOT, path.join(SCHEMA_DIR, name))
  ),
  'runner-api-types': [path.relative(REPO_ROOT, RUNNER_API_SCHEMA_PATH)]
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
}

test('every generator in the manifest lists exactly the artifacts it writes', () => {
  const manifest = readManifest()
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
    // Translate the glob to a regex without a control-character sentinel: `**` spans `/`,
    // `*` does not.
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
  // The control-plane job is the only place the generators are re-rendered and compared, so
  // its change filter has to fire for any hand edit of any artifact — including the ones in
  // other packages. Deriving the required set from the manifest is what keeps that list from
  // silently missing a file (as it did before: the github-integration projection was not
  // listed, so a hand edit of it ran no job that could detect the drift).
  const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const lines = ci.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'control-plane:')
  assert.notEqual(start, -1, 'control-plane filter not found in ci.yml')
  const indent = (lines[start] ?? '').match(/^\s*/)?.[0].length ?? 0

  const patterns: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0
    // A non-comment key at the same indent ends this filter's block.
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
