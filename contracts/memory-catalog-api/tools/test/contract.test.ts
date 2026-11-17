import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

import { parse } from 'yaml'

import { REPOSITORY_ROOT as REPO_ROOT, CONTRACT_ROOT } from '../src/paths.js'

test('the HTTP contract is a hand-maintained YAML source, not a service projection', () => {
  const contract = parse(
    readFileSync(path.join(CONTRACT_ROOT, 'v1', 'openapi.yaml'), 'utf8')
  ) as { openapi?: unknown; 'x-contract-source'?: unknown }

  expect(contract.openapi).toBe('3.1.0')
  expect(contract['x-contract-source']).toBe('hand-maintained')
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
  expect(manifest.family).toBe('memory-catalog-api')
  expect(manifest.generators.map(({ name }) => name)).toStrictEqual(['types'])
  const outputs = manifest.generators.flatMap(({ outputs }) =>
    outputs.map((output) => path.join(REPO_ROOT, output))
  )
  for (const generator of manifest.generators) {
    for (const declaredPath of [
      generator.script,
      ...generator.inputs,
      ...generator.outputs
    ]) {
      expect(
        () => readFileSync(path.join(REPO_ROOT, declaredPath)),
        `${declaredPath} is listed in the manifest but cannot be read`
      ).not.toThrow()
    }
  }
  const generatedModule = await import('../src/generate.js')

  expect(outputs).toStrictEqual(generatedModule.outputPaths.map(path.normalize))

  const filters = parse(
    readFileSync(
      path.join(REPO_ROOT, '.github', 'ci', 'changed-areas.yml'),
      'utf8'
    )
  ) as Record<string, string[]>
  for (const outputPath of generatedModule.outputPaths) {
    const relativeOutput = path.relative(REPO_ROOT, outputPath)
    expect(
      filters['contract-tools'] ?? [],
      `contract-tools CI filter does not cover ${relativeOutput}`
    ).toContain(relativeOutput)
  }
})

test('the shared fixture manifest covers every schema and fixture exactly once', () => {
  const spec = parse(
    readFileSync(path.join(CONTRACT_ROOT, 'v1/openapi.yaml'), 'utf8')
  ) as { components: { schemas: Record<string, unknown> } }
  const root = path.join(CONTRACT_ROOT, 'v1/fixtures')
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'manifest.json'), 'utf8')
  ) as {
    schema_fixtures: Record<string, string>
    invalid_schema_fixtures: Record<string, string>
  }
  const names = [
    ...Object.keys(manifest.schema_fixtures),
    ...Object.keys(manifest.invalid_schema_fixtures)
  ]
  expect(names).toHaveLength(new Set(names).size)
  expect(names.sort()).toStrictEqual(
    readdirSync(root)
      .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
      .sort()
  )
  expect(
    [...new Set(Object.values(manifest.schema_fixtures))].sort()
  ).toStrictEqual(Object.keys(spec.components.schemas).sort())
  expect(
    [...new Set(Object.values(manifest.invalid_schema_fixtures))].sort()
  ).toStrictEqual(Object.keys(spec.components.schemas).sort())
})
