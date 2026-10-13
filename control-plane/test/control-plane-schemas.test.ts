// Keep the committed Control Plane data-shape schemas in step with the OpenAPI contract.
//
// Each schema is a projection of the hand-written openapi.yaml components.schemas, so a stale
// committed file would let callers validate against a shape the service no longer produces.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  renderObservedRunSchema,
  renderReviewRunRecordSchema,
  SCHEMA_DIR
} from '../scripts/generate-control-plane-schemas.js'

function assertSchemaMatches(filename: string, render: () => string): void {
  const committed = readFileSync(path.join(SCHEMA_DIR, filename), 'utf8')
  assert.equal(
    committed,
    render(),
    `${filename} is stale. Regenerate it with: pnpm run generate:control-plane-schemas`
  )
}

test('the committed observed-run schema matches the contract', () => {
  assertSchemaMatches('observed-run.schema.json', renderObservedRunSchema)
})

test('the committed review-run-record schema matches the contract', () => {
  assertSchemaMatches('review-run-record.schema.json', renderReviewRunRecordSchema)
})
