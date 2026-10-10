// The value-level half of the observed-run contract.
//
// `observed-run-contract-types.ts` compares key sets, which catches fields that are added,
// removed, or renamed. It cannot see a value that stays inside the same field: the status
// vocabulary, a digest pattern, or a required-versus-optional change. This test covers that
// half by running a real JSON Schema validator over the shared fixtures, and by validating
// what `observeRun()` actually returns.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js'
import * as ajvFormats from 'ajv-formats'

import { observeRun } from '../src/observability.js'
import type { ReviewRunRecord } from '../src/review-store.js'

const FAMILY = path.join('contracts', 'control-plane-api', 'v1')
const FIXTURES = path.join(FAMILY, 'fixtures')

function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(path.join(current, FAMILY, 'observed-run.schema.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error('Could not locate the contract family root.')
    current = parent
  }
}

const root = workspaceRoot()
const schema = JSON.parse(
  readFileSync(path.join(root, FAMILY, 'observed-run.schema.json'), 'utf8')
) as AnySchemaObject
const manifest = JSON.parse(readFileSync(path.join(root, FIXTURES, 'manifest.json'), 'utf8')) as {
  schema_fixtures: Record<string, string>
  invalid_schema_fixtures: Record<string, string>
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(root, FIXTURES, name), 'utf8'))
}

function validate(value: unknown): boolean {
  // `ajv-formats` supplies the implementations the schema's `date-time` and `uri`
  // annotations need. Without it ajv's strict mode refuses the schema outright rather than
  // quietly skipping those assertions, so the contract's `format` keywords are enforced.
  const ajv = new Ajv2020({ allErrors: true })
  // `ajv-formats` is CommonJS whose declarations carry an `export default`, and TypeScript
  // types the module object rather than the plugin for every form tried here: a default
  // import, a namespace import's `.default`, and `import ... = require(...)`, with and
  // without `esModuleInterop`. The plugin really is on `default` at runtime, which the
  // assertions below prove the moment they run — a wrong cast makes them fail, not pass.
  const addFormats = ajvFormats.default as unknown as (instance: Ajv2020) => Ajv2020
  addFormats(ajv)
  const validator = ajv.compile(schema) as ValidateFunction
  return validator(value)
}

test('the shared fixtures match or violate the schema exactly as the manifest claims', () => {
  // A fixture that quietly stops matching the schema would teach the console a shape the
  // Control Plane never sends, so both directions are asserted.
  for (const name of Object.keys(manifest.schema_fixtures)) {
    assert.equal(validate(fixture(name)), true, `${name} must be accepted`)
  }
  for (const name of Object.keys(manifest.invalid_schema_fixtures)) {
    assert.equal(validate(fixture(name)), false, `${name} must be rejected`)
  }
})

function recordWith(artifactStorage: ReviewRunRecord['artifact_storage']): ReviewRunRecord {
  return {
    run_id: 'run-contract',
    workflow: 'repository-review',
    status: 'succeeded',
    runner_status: 'succeeded',
    publication_status: 'published',
    created_at: '2026-10-10T05:00:00.000Z',
    execution_updated_at: '2026-10-10T05:02:46.000Z',
    publication_updated_at: '2026-10-10T05:11:09.000Z',
    published_at: '2026-10-10T05:11:09.000Z',
    failure_code: null,
    failure_message: null,
    artifact_storage: artifactStorage,
    runner_input: { must: 'not leak' },
    publish_context: { repository: 'octo/example' }
  } as ReviewRunRecord
}

test('what observeRun returns validates against the shared schema', () => {
  // The schema is only a contract while the producer's own output satisfies it. This is
  // the check that would catch a status the schema's enum does not list.
  const withoutArtifact = observeRun(recordWith(null))
  assert.equal(
    validate(withoutArtifact),
    true,
    `observeRun output must be accepted: ${JSON.stringify(withoutArtifact)}`
  )

  const withArtifact = observeRun(
    recordWith({
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: 's3://sec-review/runs/run-contract/artifacts/diagnostic-tree.v1.tar.zst',
        media_type: 'application/zstd',
        digest: `sha256:${'ab'.repeat(32)}`,
        size_bytes: 1234
      }
    } as ReviewRunRecord['artifact_storage'])
  )
  assert.equal(
    validate(withArtifact),
    true,
    `observeRun output must be accepted: ${JSON.stringify(withArtifact)}`
  )
})
