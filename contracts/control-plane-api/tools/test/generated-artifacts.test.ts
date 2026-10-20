// This family's manifest must match what the generators write, and CI must trigger on it.
//
// `generated-artifacts.json` lists what is derived from this family's contract and where it
// lands. If it drifts from the generators it guards nothing, so the manifest and the code
// check each other rather than each being trusted alone.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

import { staleGeneratedArtifacts } from '../src/check-generated-artifacts.js'
import { generatedArtifacts as schemas } from '../src/generate-schemas.js'
import { generatedArtifacts as stateMachines } from '../src/generate-state-machines.js'
import { generatedArtifacts as types } from '../src/generate-types.js'
import { REPO_ROOT } from '../src/repo-root.js'

const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'control-plane-api',
  'tools',
  'generated-artifacts.json'
)

interface Manifest {
  generators: Array<{ name: string; inputs: string[]; outputs: string[] }>
}

const ACTUAL_OUTPUTS: Record<string, string[]> = {
  types: types().map((a) => path.relative(REPO_ROOT, a.output)),
  schemas: schemas().map((a) => path.relative(REPO_ROOT, a.output)),
  'state-machines': stateMachines().map((a) =>
    path.relative(REPO_ROOT, a.output)
  )
}

test('every committed artifact matches a fresh render', async () => {
  const stale = await staleGeneratedArtifacts()
  assert.deepStrictEqual(
    stale,
    [],
    `these are stale:\n${stale.map((s) => `  ${s.output} -> ${s.command}`).join('\n')}`
  )
})

test('the manifest lists exactly the artifacts the generators write', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  const byName = new Map(manifest.generators.map((g) => [g.name, g.outputs]))
  assert.deepStrictEqual(
    [...byName.keys()].sort(),
    Object.keys(ACTUAL_OUTPUTS).sort(),
    'the manifest lists a different set of generators than the code has'
  )
  for (const [name, outputs] of Object.entries(ACTUAL_OUTPUTS)) {
    assert.deepStrictEqual(
      [...(byName.get(name) ?? [])].sort(),
      [...outputs].sort(),
      `manifest outputs for ${name} do not match the generator`
    )
  }
})

test('every input the manifest names exists', () => {
  // `inputs` states what a generator reads. A path that does not exist is a false statement
  // about the generation relationship: either the input was moved, or the declaration was
  // never accurate. Both make the manifest useless for deciding what to regenerate.
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  for (const generator of manifest.generators) {
    for (const input of generator.inputs) {
      assert.ok(
        existsSync(path.join(REPO_ROOT, input)),
        `${generator.name} declares input ${input}, which does not exist`
      )
    }
  }
})

test('every file the manifest names exists', () => {
  for (const generator of (
    JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  ).generators) {
    for (const output of generator.outputs) {
      assert.doesNotThrow(
        () => readFileSync(path.join(REPO_ROOT, output), 'utf8'),
        `${output} is listed in the manifest but cannot be read`
      )
    }
  }
})

/** Does any glob in `patterns` cover `filePath`? Supports `**` and `*`; exact strings match. */
function globCovers(patterns: string[], filePath: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === filePath) return true
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
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

test('the contract-tools CI filter triggers on every artifact of this family', () => {
  // The tool's staleness check runs in the contract-tools job, so its change filter has to fire
  // for a hand edit of any artifact this family produces — including the projections that land in
  // other packages. `.github/ci/changed-areas.yml` is CI's single source for this (read directly
  // by `dorny/paths-filter`; `.github/ci/check-changed-areas.mjs` guards the model itself).

  const filters = parse(
    readFileSync(
      path.join(REPO_ROOT, '.github', 'ci', 'changed-areas.yml'),
      'utf8'
    )
  ) as Record<string, string[]>
  const patterns = filters['contract-tools'] ?? []
  assert.ok(patterns.length > 0, 'no patterns for the contract-tools area')

  const required = (
    JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
  ).generators.flatMap((generator) => generator.outputs)
  for (const output of required) {
    assert.ok(
      globCovers(patterns, output),
      `the contract-tools CI filter does not cover ${output}; a hand edit of it would run no ` +
        'job that detects the drift'
    )
  }
})
