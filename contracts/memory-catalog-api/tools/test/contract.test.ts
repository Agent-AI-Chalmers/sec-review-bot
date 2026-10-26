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
  ) as { artifacts: Array<{ generator: string; output: string }> }
  const outputs = manifest.artifacts.map(({ output }) =>
    path.normalize(path.join(CONTRACT_ROOT, 'tools', output))
  )
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
