import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDeliveryDraftPrTitle } from '../../../reviews/repositories/delivery-title.js'

test('repository draft PR title uses the primary changed code file and case id', () => {
  const title = buildDeliveryDraftPrTitle({
    delivery_id: 'delivery-1',
    file_changes: [{ path: 'src/server.js' }],
    case_ids: ['case-1'],
    case_count: 1
  })

  assert.equal(title, '[sec] Fix security issue in src/server.js (case-1)')
})

test('repository draft PR title falls back to delivery id when case id is missing', () => {
  const title = buildDeliveryDraftPrTitle({
    delivery_id: 'delivery-1',
    file_changes: [{ path: 'src/server.js' }],
    case_ids: [],
    case_count: 1
  })

  assert.equal(title, '[sec] Fix security issue in src/server.js (delivery-1)')
})

test('repository draft PR title uses primary case id and related count for combined deliveries', () => {
  const title = buildDeliveryDraftPrTitle({
    delivery_id: 'delivery-1',
    file_changes: [{ path: 'README.md' }, { path: 'src/server.js' }],
    case_ids: ['case-1', 'case-2'],
    case_count: 2
  })

  assert.equal(title, '[sec] Fix security issue in src/server.js (case-1 +1 related case)')
})
