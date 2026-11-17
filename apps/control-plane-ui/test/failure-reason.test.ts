import { expect, test } from 'vitest'

import { ApiError } from '../browser/shared/api-client.js'
import { failureReason } from '../browser/shared/format.js'
import { translate, type Translator } from '../browser/shared/i18n.js'

const t: Translator = (key, ...args) => translate('en', key, ...args)

test('failure reasons name only the service identified by the error code', () => {
  expect(failureReason(new ApiError(502, 'review_runs_unavailable'), t)).toBe(
    'Review Runs is unavailable.'
  )
  expect(failureReason(new ApiError(504, 'memory_catalog_timeout'), t)).toBe(
    'Memory Catalog timed out.'
  )
})

test('unknown server failures remain service-neutral', () => {
  expect(failureReason(new ApiError(502, 'artifact_read_failed'), t)).toBe(
    'Error 502.'
  )
  expect(failureReason(new ApiError(404, 'not_found'), t)).toBe(undefined)
  expect(failureReason(new Error('network unavailable'), t)).toBe(undefined)
})
