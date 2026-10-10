import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js'
// Same shape as the unit suite's check: `ajv-formats` is CommonJS with an `export default`
// declaration, and TypeScript types the module object rather than the plugin under this
// package's compiler options.
import * as ajvFormats from 'ajv-formats'

import { ReviewRunStore } from '../../src/index.js'

// The record contract's value-level check.
//
// `review-run-record-contract-types.ts` compares the type's keys to the schema's, and the
// fixture test in the unit suite proves the fixtures match. Neither can see an actual
// record, because one only exists once a row is written. This suite has a database, so it
// validates what `getRun` really returns — the same thing the observed-run check does for
// `observeRun()`.

const FAMILY = path.join('contracts', 'control-plane-api', 'v1')

function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(path.join(current, FAMILY, 'review-run-record.schema.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error('Could not locate the contract family root.')
    current = parent
  }
}

const root = workspaceRoot()

function readSchema(): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(path.join(root, FAMILY, 'review-run-record.schema.json'), 'utf8')
  ) as AnySchemaObject
  const ajv = new Ajv2020({ allErrors: true })
  const addFormats = ajvFormats.default as unknown as (instance: Ajv2020) => Ajv2020
  addFormats(ajv)
  return ajv.compile(schema) as ValidateFunction
}

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

async function createStore(): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: `test:${randomUUID()}`
  })
  await store.initialize()
  return store
}

test('the record getRun returns validates against the shared schema', async () => {
  const validate = readSchema()
  const store = await createStore()
  try {
    const runId = `run-${randomUUID()}`
    const admission = await store.create_preparing_review_run({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: { repository: 'octo/example' },
      ingress_kind: 'github_webhook',
      ingress_key: `delivery:${randomUUID()}`
    })
    assert.ok(admission.preparation_token)

    const preparing = await store.getRun(runId)
    assert.equal(
      validate(preparing),
      true,
      `a preparing record must be accepted: ${JSON.stringify(validate.errors)}`
    )

    await store.mark_queued(runId, admission.preparation_token, { repository: 'octo/example' })
    await store.recordRunnerSuccess(runId, { run_id: runId }, { status: 'unavailable' })

    const succeeded = await store.getRun(runId)
    assert.equal(
      validate(succeeded),
      true,
      `a succeeded record must be accepted: ${JSON.stringify(validate.errors)}`
    )
  } finally {
    await store.close()
  }
})
