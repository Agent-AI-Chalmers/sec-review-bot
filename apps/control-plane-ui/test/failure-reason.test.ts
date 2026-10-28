import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError } from '../browser/shared/api-client.js'
import { failureReason } from '../browser/shared/format.js'
import { messages, type Message } from '../browser/shared/i18n.js'

const t = (key: Message): string => messages.en[key]

test('failure reasons name only the service identified by the error code', () => {
  assert.equal(
    failureReason(new ApiError(502, 'review_runs_unavailable'), t),
    'Review Runs is unavailable.'
  )
  assert.equal(
    failureReason(new ApiError(504, 'memory_catalog_timeout'), t),
    'Memory Catalog timed out.'
  )
})

test('unknown server failures remain service-neutral', () => {
  assert.equal(
    failureReason(new ApiError(502, 'artifact_read_failed'), t),
    'Error 502.'
  )
  assert.equal(failureReason(new ApiError(404, 'not_found'), t), undefined)
  assert.equal(failureReason(new Error('network unavailable'), t), undefined)
})
