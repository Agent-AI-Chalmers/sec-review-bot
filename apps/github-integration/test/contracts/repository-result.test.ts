import assert from 'node:assert/strict'
import test from 'node:test'

import { contractFixture } from '../contract-fixtures.js'
import { parseRepositoryWorkflowResult } from '../../reviews/repositories/result.js'

test('repository result rejects malformed delivery file changes before draft PR publishing', () => {
  assert.throws(
    () => parseRepositoryWorkflowResult({
      contract_version: 'v4',
      scan_summary: {},
      case_results: [],
      deliveries: [
        {
          delivery_id: 'delivery-bad',
          case_ids: ['case-1'],
          file_changes: [
            {
              path: 'src/app.txt',
              status: 'upsert',
              content: 'alpha updated\n',
              content_encoding: 'utf-8'
            },
            {
              path: 'src/app.txt',
              status: 'deleted'
            }
          ]
        }
      ]
    }),
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
    /contract_version must be v4/
  )
})

test('repository result rejects upsert changes without content_encoding', () => {
  assert.throws(
    () => parseRepositoryWorkflowResult({
      contract_version: 'v4',
      scan_summary: {},
      case_results: [],
      deliveries: [
        {
          delivery_id: 'delivery-missing-encoding',
          case_ids: ['case-1'],
          file_changes: [
            {
              path: 'src/app.txt',
              status: 'upsert',
              content: 'alpha updated\n'
            }
          ]
        }
      ]
    }),
    /unsupported file change encoding/
  )
})

test('repository result rejects unsupported file modes', () => {
  assert.throws(
    () => parseRepositoryWorkflowResult({
      contract_version: 'v4',
      scan_summary: {},
      case_results: [],
      deliveries: [
        {
          delivery_id: 'delivery-bad-mode',
          case_ids: ['case-1'],
          file_changes: [
            {
              path: 'src/app.txt',
              status: 'upsert',
              content: 'alpha updated\n',
              content_encoding: 'utf-8',
              mode: '100600'
            }
          ]
        }
      ]
    }),
    /unsupported file mode/
  )
})

for (const [path, message] of [
  ['../x', /Unsafe repository file path/],
  ['/abs', /Unsafe repository file path/],
  ['C:src/app.txt', /Unsafe repository file path/],
  ['C:/src/app.txt', /Unsafe repository file path/],
  [' src/app.txt ', /Unsafe repository file path/],
  ['src\\app.txt', /Unsafe repository file path/],
  ['.git/config', /targets \.git/],
  ['.github/workflows/pwn.yml', /Sensitive repository file path/]
] as const) {
  test(`repository result rejects unsafe delivery path ${path}`, () => {
    assert.throws(
      () => parseRepositoryWorkflowResult({
        contract_version: 'v4',
        scan_summary: {},
        case_results: [],
        deliveries: [
          {
            delivery_id: 'delivery-unsafe-path',
            case_ids: ['case-1'],
            file_changes: [
              {
                path,
                status: 'upsert',
                content: 'alpha updated\n',
                content_encoding: 'utf-8'
              }
            ]
          }
        ]
      }),
      message
    )
  })
}
