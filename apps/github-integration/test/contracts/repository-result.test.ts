import assert from 'node:assert/strict'
import test from 'node:test'

import { contractFixture } from '../contract-fixtures.js'
import { parseRepositoryWorkflowResult } from '../../reviews/repositories/result.js'

interface RepositoryDeliveryFixture {
  delivery_id: string
  case_ids: string[]
  file_changes: [Record<string, unknown>, ...Array<Record<string, unknown>>]
}

interface RepositoryResultFixture {
  contract_version: string
  scan_summary: Record<string, unknown>
  case_results: unknown[]
  deliveries: [RepositoryDeliveryFixture, ...RepositoryDeliveryFixture[]]
  [key: string]: unknown
}

function validRepositoryResult (): RepositoryResultFixture {
  return structuredClone(contractFixture('v4', 'repository-review-result.json')) as RepositoryResultFixture
}

test('repository result rejects malformed delivery file changes before draft PR publishing', () => {
  const result = validRepositoryResult()
  result.deliveries[0].file_changes.push({
    path: 'src/webhook.ts',
    status: 'deleted'
  })

  assert.throws(
    () => parseRepositoryWorkflowResult(result),
    /duplicate file change entries/
  )
})

test('repository result parser accepts the shared v4 repository result fixture', () => {
  const result = parseRepositoryWorkflowResult(contractFixture('v4', 'repository-review-result.json'))

  assert.equal(result.contract_version, 'v4')
  assert.equal(result.case_results.at(0)?.case_id, 'case-1')
  assert.equal(result.deliveries.at(0)?.delivery_id, 'delivery-1')
})

test('repository result parser accepts the shared v4 blocked result fixture', () => {
  const result = parseRepositoryWorkflowResult(contractFixture('v4', 'repository-review-result-blocked.json'))

  assert.equal(result.contract_version, 'v4')
  assert.equal(result.case_results.at(0)?.disposition, 'blocked')
  assert.deepEqual(result.deliveries, [])
})

test('repository result rejects malformed v4 result before draft PR publishing', () => {
  assert.throws(
    () => parseRepositoryWorkflowResult({
      scan_summary: {},
      case_results: [],
      deliveries: []
    }),
    /repository-review result does not match contract v4/
  )
})

test('repository result rejects additional top-level fields at the production boundary', () => {
  const result = validRepositoryResult()
  result.unpublished_internal_state = true

  assert.throws(
    () => parseRepositoryWorkflowResult(result),
    /repository-review result does not match contract v4/
  )
})

test('repository result rejects incomplete scan_summary at the production boundary', () => {
  const result = validRepositoryResult()
  delete result.scan_summary.scanned_file_count

  assert.throws(
    () => parseRepositoryWorkflowResult(result),
    /repository-review result does not match contract v4/
  )
})

test('repository result rejects upsert changes without content_encoding', () => {
  const result = validRepositoryResult()
  delete result.deliveries[0].file_changes[0].content_encoding

  assert.throws(
    () => parseRepositoryWorkflowResult(result),
    /repository-review result does not match contract v4/
  )
})

test('repository result rejects unsupported file modes', () => {
  const result = validRepositoryResult()
  result.deliveries[0].file_changes[0].mode = '100600'

  assert.throws(
    () => parseRepositoryWorkflowResult(result),
    /repository-review result does not match contract v4/
  )
})

for (const [path, message] of [
  ['../x', /repository-review result does not match contract v4/],
  ['/abs', /repository-review result does not match contract v4/],
  ['C:src/app.txt', /repository-review result does not match contract v4/],
  ['C:/src/app.txt', /repository-review result does not match contract v4/],
  [' src/app.txt ', /repository-review result does not match contract v4/],
  ['src\\app.txt', /repository-review result does not match contract v4/],
  ['.git/config', /repository-review result does not match contract v4/],
  ['.github/workflows/pwn.yml', /Sensitive repository file path/]
] as const) {
  test(`repository result rejects unsafe delivery path ${path}`, () => {
    const result = validRepositoryResult()
    result.deliveries[0].file_changes[0].path = path

    assert.throws(
      () => parseRepositoryWorkflowResult(result),
      message
    )
  })
}
