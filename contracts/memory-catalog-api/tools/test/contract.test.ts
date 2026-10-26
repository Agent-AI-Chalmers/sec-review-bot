import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const CONTRACT_ROOT = path.join(REPO_ROOT, 'contracts', 'memory-catalog-api')

test('the HTTP contract is a hand-maintained YAML source, not a service projection', () => {
  const contract = parse(
    readFileSync(path.join(CONTRACT_ROOT, 'v1', 'openapi.yaml'), 'utf8')
  ) as { openapi?: unknown; 'x-contract-source'?: unknown }

  assert.equal(contract.openapi, '3.1.0')
  assert.equal(contract['x-contract-source'], 'hand-maintained')
})

test('the generated artifact manifest covers the generator output and CI filter', async () => {
  const manifest = JSON.parse(
    readFileSync(
      path.join(CONTRACT_ROOT, 'tools', 'generated-artifacts.json'),
      'utf8'
    )
  ) as {
    family: string
    generators: Array<{
      name: string
      script: string
      inputs: string[]
      outputs: string[]
    }>
  }
  assert.equal(manifest.family, 'memory-catalog-api')
  assert.deepEqual(
    manifest.generators.map(({ name }) => name),
    ['types']
  )
  const outputs = manifest.generators.flatMap(({ outputs }) =>
    outputs.map((output) => path.join(REPO_ROOT, output))
  )
  for (const generator of manifest.generators) {
    for (const declaredPath of [
      generator.script,
      ...generator.inputs,
      ...generator.outputs
    ]) {
      assert.doesNotThrow(
        () => readFileSync(path.join(REPO_ROOT, declaredPath)),
        `${declaredPath} is listed in the manifest but cannot be read`
      )
    }
  }
  const generatedModule = await import('../src/generate.js')

  assert.deepEqual(outputs, generatedModule.outputPaths.map(path.normalize))

  const filters = parse(
    readFileSync(
      path.join(REPO_ROOT, '.github', 'ci', 'changed-areas.yml'),
      'utf8'
    )
  ) as Record<string, string[]>
  for (const outputPath of generatedModule.outputPaths) {
    const relativeOutput = path.relative(REPO_ROOT, outputPath)
    assert.ok(
      (filters['contract-tools'] ?? []).includes(relativeOutput),
      `contract-tools CI filter does not cover ${relativeOutput}`
    )
  }
})
