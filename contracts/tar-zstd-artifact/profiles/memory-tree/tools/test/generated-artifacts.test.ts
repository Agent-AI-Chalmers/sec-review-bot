import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

import generatedArtifacts from '../generated-artifacts.json' with { type: 'json' }
import { corpusCaseDefinitions } from '../src/corpus.js'

import { REPOSITORY_ROOT as REPO_ROOT } from '../src/paths.js'

test('the generated artifact manifest exactly covers fixture outputs', () => {
  const expected = [
    'contracts/tar-zstd-artifact/profiles/memory-tree/v1/corpus/manifest.json',
    ...corpusCaseDefinitions().map(
      ({ file }) => `contracts/tar-zstd-artifact/profiles/memory-tree/v1/corpus/${file}`
    )
  ]
  expect(generatedArtifacts.family).toBe('tar-zstd-artifact/profiles/memory-tree')
  expect(generatedArtifacts.generators.map(({ name }) => name)).toStrictEqual(['corpus'])
  expect(generatedArtifacts.generators[0]?.outputs).toStrictEqual(expected)
})

test('every generated artifact identifies an existing committed file', () => {
  for (const generator of generatedArtifacts.generators) {
    for (const declaredPath of [
      generator.script,
      ...generator.code_inputs,
      ...generator.inputs,
      ...generator.outputs
    ]) {
      expect(
        () => readFileSync(path.join(REPO_ROOT, declaredPath)),
        `${declaredPath} is listed in the manifest but cannot be read`
      ).not.toThrow()
    }
  }
})
