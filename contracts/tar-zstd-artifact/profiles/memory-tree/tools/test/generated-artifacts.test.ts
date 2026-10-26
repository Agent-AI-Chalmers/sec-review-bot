import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import generatedArtifacts from '../generated-artifacts.json' with { type: 'json' }
import { corpusCaseDefinitions } from '../src/corpus.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../../..')

test('the generated artifact manifest exactly covers fixture outputs', () => {
  const expected = [
    'contracts/tar-zstd-artifact/profiles/memory-tree/v1/corpus/manifest.json',
    ...corpusCaseDefinitions().map(
      ({ file }) =>
        `contracts/tar-zstd-artifact/profiles/memory-tree/v1/corpus/${file}`
    )
  ]
  assert.equal(
    generatedArtifacts.family,
    'tar-zstd-artifact/profiles/memory-tree'
  )
  assert.deepEqual(
    generatedArtifacts.generators.map(({ name }) => name),
    ['corpus']
  )
  assert.deepEqual(generatedArtifacts.generators[0]?.outputs, expected)
})

test('every generated artifact identifies an existing committed file', () => {
  for (const generator of generatedArtifacts.generators) {
    for (const declaredPath of [
      generator.script,
      ...generator.code_inputs,
      ...generator.inputs,
      ...generator.outputs
    ]) {
      assert.doesNotThrow(
        () => readFileSync(path.join(REPO_ROOT, declaredPath)),
        `${declaredPath} is listed in the manifest but cannot be read`
      )
    }
  }
})
