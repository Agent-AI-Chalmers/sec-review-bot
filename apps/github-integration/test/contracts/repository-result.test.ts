import { expect, test } from 'vitest'

import { contractFixture } from '../contract-fixtures.js'
import { parseRepositoryWorkflowResult } from '../../src/reviews/repositories/result.js'

interface RepositoryDeliveryFixture {
  delivery_id: string
  case_ids: string[]
  file_changes: [Record<string, unknown>, ...Array<Record<string, unknown>>]
}

interface RepositoryResultFixture {
  api_version: string
  scan_summary: Record<string, unknown>
  case_results: unknown[]
  deliveries: [RepositoryDeliveryFixture, ...RepositoryDeliveryFixture[]]
  [key: string]: unknown
}

function validRepositoryResult(): RepositoryResultFixture {
  return structuredClone(
    contractFixture('repository-review-result.json')
  ) as RepositoryResultFixture
}

test('repository result rejects malformed delivery file changes before draft PR publishing', () => {
  const result = validRepositoryResult()
  result.deliveries[0].file_changes.push({
    path: 'src/webhook.ts',
    status: 'deleted'
  })

  expect(() => parseRepositoryWorkflowResult(result)).toThrow(/duplicate file change entries/)
})

test('repository result parser accepts the shared v1 repository result fixture', () => {
  const result = parseRepositoryWorkflowResult(contractFixture('repository-review-result.json'))

  expect(result.api_version).toBe('v1')
  expect(result.case_results.at(0)?.case_id).toBe('case-1')
  expect(result.deliveries.at(0)?.delivery_id).toBe('delivery-1')
})

test('repository result parser accepts the shared v1 blocked result fixture', () => {
  const result = parseRepositoryWorkflowResult(
    contractFixture('repository-review-result-blocked.json')
  )

  expect(result.api_version).toBe('v1')
  expect(result.case_results.at(0)?.deliverable).toBe(false)
  expect(result.deliveries).toStrictEqual([])
})

test('repository result rejects duplicate delivery identities', () => {
  const result = validRepositoryResult()
  result.deliveries.push(structuredClone(result.deliveries[0]))

  expect(() => parseRepositoryWorkflowResult(result)).toThrow(/duplicate delivery_id/)
})

test('repository result rejects malformed v1 result before draft PR publishing', () => {
  expect(() =>
    parseRepositoryWorkflowResult({
      scan_summary: {},
      case_results: [],
      deliveries: []
    })
  ).toThrow(/repository-review result does not match API v1/)
})

test('repository result rejects additional top-level fields at the production boundary', () => {
  const result = validRepositoryResult()
  result.unpublished_internal_state = true

  expect(() => parseRepositoryWorkflowResult(result)).toThrow(
    /repository-review result does not match API v1/
  )
})

test('repository result rejects incomplete scan_summary at the production boundary', () => {
  const result = validRepositoryResult()
  delete result.scan_summary.scanned_file_count

  expect(() => parseRepositoryWorkflowResult(result)).toThrow(
    /repository-review result does not match API v1/
  )
})

test('repository result rejects upsert changes without content_encoding', () => {
  const result = validRepositoryResult()
  delete result.deliveries[0].file_changes[0].content_encoding

  expect(() => parseRepositoryWorkflowResult(result)).toThrow(
    /repository-review result does not match API v1/
  )
})

test('repository result rejects unsupported file modes', () => {
  const result = validRepositoryResult()
  result.deliveries[0].file_changes[0].mode = '100600'

  expect(() => parseRepositoryWorkflowResult(result)).toThrow(
    /repository-review result does not match API v1/
  )
})

for (const [path, message] of [
  ['../x', /repository-review result does not match API v1/],
  ['/abs', /repository-review result does not match API v1/],
  ['C:src/app.txt', /repository-review result does not match API v1/],
  ['C:/src/app.txt', /repository-review result does not match API v1/],
  [' src/app.txt ', /repository-review result does not match API v1/],
  ['src\\app.txt', /repository-review result does not match API v1/],
  ['.git/config', /repository-review result does not match API v1/],
  ['.github/workflows/pwn.yml', /Sensitive repository file path/]
] as const) {
  test(`repository result rejects unsafe delivery path ${path}`, () => {
    const result = validRepositoryResult()
    result.deliveries[0].file_changes[0].path = path

    expect(() => parseRepositoryWorkflowResult(result)).toThrow(message)
  })
}
