// This family's manifest must match what the generators write, and CI must trigger on it.
//
// `generated-artifacts.json` lists what is derived from this family's contract and where it
// lands. If it drifts from the generators it guards nothing, so the manifest and the code
// check each other rather than each being trusted alone.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { staleGeneratedArtifacts } from '../src/check-generated-artifacts.js'
import { generatedArtifacts as types } from '../src/generate-types.js'
import { REPO_ROOT } from '../src/repo-root.js'

const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'integration-contract',
  'tools',
  'generated-artifacts.json'
)

interface Manifest {
  generators: Array<{ name: string; outputs: string[] }>
}

const ACTUAL_OUTPUTS: Record<string, string[]> = {
  types: types().map((a) => path.relative(REPO_ROOT, a.output))
}

test('every committed artifact matches a fresh render', async () => {
  const stale = await staleGeneratedArtifacts()
  assert.deepEqual(
    stale,
    [],
    `these are stale:\n${stale.map((s) => `  ${s.output} -> ${s.command}`).join('\n')}`
  )
})

test('the manifest lists exactly the artifacts the generators write', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
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
  for (const generator of (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest)
    .generators) {
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
  // The tool's staleness check runs in the contract-tools job, so its change filter has to
  // fire for any hand edit of any artifact this family produces — including the ones in other
  // packages. Deriving the required set from the manifest keeps the list from silently
  // missing a file.
  const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const lines = ci.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'contract-tools:')
  assert.notEqual(start, -1, 'contract-tools filter not found in ci.yml')
  const indent = (lines[start] ?? '').match(/^\s*/)?.[0].length ?? 0

  const patterns: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0
    if (line.trim() !== '' && lineIndent <= indent && !line.trim().startsWith('#')) break
    const match = line.match(/^\s*-\s*'([^']+)'\s*$/)
    if (match?.[1] !== undefined) patterns.push(match[1])
  }
  assert.ok(patterns.length > 0, 'no patterns parsed for the contract-tools filter')

  const required = (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest).generators.flatMap(
    (generator) => generator.outputs
  )
  for (const output of required) {
    assert.ok(
      globCovers(patterns, output),
      `the contract-tools CI filter does not cover ${output}; a hand edit of it would run no ` +
        'job that detects the drift'
    )
  }
})
