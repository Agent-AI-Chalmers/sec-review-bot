// The value-level check of the observed-run contract.
//
// The type and the schema both derive from the contract's `ObservedRun` (`openapi.yaml`), so
// they cannot drift apart by construction. This test covers what that cannot see: that the
// producer's own output actually satisfies the schema, and that the shared fixtures match or
// violate it exactly as the manifest claims, by running a real JSON Schema validator.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  Ajv2020,
  type AnySchemaObject,
  type ValidateFunction
} from 'ajv/dist/2020.js'
import * as ajvFormats from 'ajv-formats'

import { REPO_ROOT } from './generated-paths.js'
import { observeRun } from '../src/observability.js'
import type { ReviewRunRecord } from '../src/review-store.js'

const CONTRACT_VERSION_DIR = path.join('contracts', 'review-runs-api', 'v1')
const FIXTURES = path.join(CONTRACT_VERSION_DIR, 'fixtures')

const root = REPO_ROOT
// One contract version can hold several schemas, so each fixture is validated against the schema the
// manifest names for it rather than against whichever schema was loaded first.
const manifest = JSON.parse(
  readFileSync(path.join(root, FIXTURES, 'manifest.json'), 'utf8')
) as {
  schema_fixtures: Record<string, string>
  invalid_schema_fixtures: Record<string, string>
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(root, FIXTURES, name), 'utf8'))
}

const validators = new Map<string, ValidateFunction>()

function validate(schemaName: string, value: unknown): boolean {
  const cached = validators.get(schemaName)
  if (cached !== undefined) return cached(value)
  const schema = JSON.parse(
    readFileSync(path.join(root, CONTRACT_VERSION_DIR, schemaName), 'utf8')
  ) as AnySchemaObject
  // `ajv-formats` supplies the implementations the schema's `date-time` and `uri`
  // annotations need. Without it ajv's strict mode refuses the schema outright rather than
  // quietly skipping those assertions, so the contract's `format` keywords are enforced.
  const ajv = new Ajv2020({ allErrors: true })
  // `ajv-formats` is CommonJS whose declarations carry an `export default`, and TypeScript
  // types the module object rather than the plugin for every form tried here: a default
  // import, a namespace import's `.default`, and `import ... = require(...)`, with and
  // without `esModuleInterop`. The plugin really is on `default` at runtime, which the
  // assertions below prove the moment they run — a wrong cast makes them fail, not pass.
  const addFormats = ajvFormats.default as unknown as (
    instance: Ajv2020
  ) => Ajv2020
  addFormats(ajv)
  const validator = ajv.compile(schema) as ValidateFunction
  validators.set(schemaName, validator)
  return validator(value)
}

test('the shared fixtures match or violate the schema exactly as the manifest claims', () => {
  // A fixture that quietly stops matching the schema would teach the console a shape the
  // Review Runs never sends, so both directions are asserted.
  for (const [name, schemaName] of Object.entries(manifest.schema_fixtures)) {
    assert.strictEqual(
      validate(schemaName, fixture(name)),
      true,
      `${name} must be accepted`
    )
  }
  for (const [name, schemaName] of Object.entries(
    manifest.invalid_schema_fixtures
  )) {
    assert.strictEqual(
      validate(schemaName, fixture(name)),
      false,
      `${name} must be rejected`
    )
  }
})

test('a comment_url must be an absolute URI, not just any string', () => {
  // `format` keywords are only enforced because `ajv-formats` is installed, and a schema that
  // merely said `type: string` would accept "not a url". This pins the constraint itself rather
  // than relying on the negative fixture to fail for the right reason by luck.
  const base = fixture('observed-run.json') as Record<string, unknown>
  const withUrl = (url: unknown): unknown => ({
    ...base,
    notices: [
      {
        ...(base.notices as Array<Record<string, unknown>>)[0]!,
        comment_url: url
      }
    ]
  })
  assert.strictEqual(
    validate('observed-run.schema.json', withUrl('https://example.test/c/1')),
    true,
    'an absolute https URI is accepted'
  )
  for (const bad of ['not a url', '', 'example.test/c/1', 42]) {
    assert.strictEqual(
      validate('observed-run.schema.json', withUrl(bad)),
      false,
      `${JSON.stringify(bad)} must not be accepted as a comment_url`
    )
  }
  assert.strictEqual(
    validate('observed-run.schema.json', withUrl(null)),
    true,
    'null stays valid: it is how "nobody was told" is reported'
  )
})

/** Every key path in `value`, so two fixtures can be compared by shape alone. */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [prefix]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => paths(child, prefix === '' ? key : `${prefix}.${key}`)
  )
}

test('each invalid fixture differs from its valid counterpart only where it intends', () => {
  // A negative fixture proves nothing if it is rejected for the wrong reason. These were
  // hand-copied, so adding a required field to the contract kept them failing — but on the
  // missing field rather than on the defect each one is named for, which silently retired the
  // whole negative suite. Requiring the key skeleton to match the valid fixture prevents that:
  // a new required field has to be added here too, and the only remaining difference is the
  // defect itself.
  const pairs: Array<[string, string]> = [
    ['observed-run.json', 'invalid-observed-run'],
    ['review-run-record.json', 'invalid-review-run-record']
  ]
  for (const [valid, prefix] of pairs) {
    const expected = paths(fixture(valid)).sort()
    for (const name of Object.keys(manifest.invalid_schema_fixtures)) {
      if (!name.startsWith(prefix)) continue
      // Only a fixture whose name says a field is missing may omit valid paths. Every other one
      // has to carry the complete valid shape and differ by value (or by one stray field), so a
      // required field added to the contract forces all of them to be updated instead of quietly
      // turning every negative case into "rejected for the missing field".
      const actual = paths(fixture(name)).sort()
      const extra = actual.filter((item) => !expected.includes(item))
      const missing = expected.filter((item) => !actual.includes(item))
      const mayOmit = name.includes('missing-') || name.includes('without-')
      assert.ok(
        extra.length <= 1 && (mayOmit || missing.length === 0),
        `${name} must keep the shape of ${valid} so it fails on its own defect ` +
          `(unexpected: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`
      )
    }
  }
})

function recordWith(
  artifactStorage: ReviewRunRecord['artifact_storage']
): ReviewRunRecord {
  return {
    run_id: 'run-contract',
    workflow: 'repository-review',
    source_platform: 'github',
    connector_id: 'github-integration:test',
    preparation: {
      status: 'submitted',
      attempt_count: 1,
      started_at: '2026-01-01T00:00:10.000Z',
      finished_at: '2026-01-01T00:00:30.000Z',
      updated_at: '2026-01-01T00:00:03.000Z',
      failure_code: null,
      disconnect_reason: null
    },
    // The fixtures describe states the store can actually produce. `succeeded` means the
    // execution ran and ended, and `published` means the publication started and ended; a
    // fixture that pairs a terminal status with absent timestamps would teach the schema test
    // that an impossible record is acceptable.
    execution: {
      status: 'succeeded',
      started_at: '2026-01-01T00:00:01.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z'
    },
    publication: {
      status: 'published',
      started_at: '2026-01-01T00:02:00.000Z',
      finished_at: '2026-01-01T00:03:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    created_at: '2026-10-10T05:00:00.000Z',
    failure_code: null,
    failure_message: null,
    artifact_storage: artifactStorage,
    notices: [],
    execution_input: { must: 'not leak' },
    publish_context: { repository: 'octo/example' }
  } as ReviewRunRecord
}

test('the redacted read never carries a field the observed schema does not declare', () => {
  // `observeRun` forwards the axis objects it is given rather than re-listing their fields, so
  // the redaction boundary is the schema, not the function body: anything the record grows that
  // the read contract does not declare would travel to the read surface verbatim. The value-level
  // test below already rejects such an object; this one compares key sets so the failure names
  // the unexpected field instead of reporting an opaque schema violation. Together they keep the
  // rule that a new internal field must enter the read contract or stay off the record.
  const record = recordWith(null)
  const observed = observeRun(record) as unknown as Record<string, unknown>
  assert.deepStrictEqual(
    Object.keys(observed).sort(),
    [
      'artifact_storage',
      'connector_id',
      'created_at',
      'execution',
      'execution_statistics',
      'failure_code',
      'notices',
      'preparation',
      'publication',
      'run_id',
      'source_platform',
      'workflow'
    ],
    'the observed run must carry exactly the fields its schema declares'
  )
  // The connector-owned record fields are the ones that must not survive redaction.
  for (const dropped of [
    'publish_context',
    'execution_input',
    'failure_message'
  ]) {
    assert.ok(
      !(dropped in observed),
      `${dropped} is record-only and must not reach the redacted read`
    )
  }
  // Nested axis objects are forwarded as-is, so checking only the top-level keys would miss the
  // case that matters most: an internal field attached to an axis. The preparation summary is
  // the axis most likely to grow one, and every field it carries must be one the schema names.
  const preparation = observed.preparation as Record<string, unknown>
  assert.deepStrictEqual(
    Object.keys(preparation).sort(),
    [
      'attempt_count',
      'disconnect_reason',
      'failure_code',
      'finished_at',
      'started_at',
      'status',
      'updated_at'
    ],
    'every preparation field must be a field the read contract declares'
  )
})

test('what observeRun returns validates against the shared schema', () => {
  // The schema is only a contract while the producer's own output satisfies it. This is
  // the check that would catch a status the schema's enum does not list.
  const withoutArtifact = observeRun(recordWith(null))
  assert.strictEqual(
    validate('observed-run.schema.json', withoutArtifact),
    true,
    `observeRun output must be accepted: ${JSON.stringify(withoutArtifact)}`
  )

  const withArtifact = observeRun(
    recordWith({
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: 's3://sec-review/runs/run-contract/artifacts/diagnostic-tree.v1.tar.zst',
        media_type: 'application/tar+zstd',
        digest: `sha256:${'ab'.repeat(32)}`,
        size_bytes: 1234
      }
    } as ReviewRunRecord['artifact_storage'])
  )
  assert.strictEqual(
    validate('observed-run.schema.json', withArtifact),
    true,
    `observeRun output must be accepted: ${JSON.stringify(withArtifact)}`
  )
})
