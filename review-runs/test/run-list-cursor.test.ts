import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeRunListCursor,
  encodeRunListCursor
} from '../src/persistence/review-run-queries.js'

const CURSOR = {
  created_at_cursor: '2026-10-30T15:04:05.123456Z',
  run_id: '11111111-2222-3333-4444-555555555555'
}

/**
 * The cursor names a row by the same pair the ordering uses, so a lost or reinterpreted field
 * silently restarts pagination instead of failing. These pin the wire form to exactly what the
 * encoder writes.
 */
test('a run list cursor round-trips through the wire form', () => {
  assert.deepStrictEqual(
    decodeRunListCursor(encodeRunListCursor(CURSOR)),
    CURSOR
  )
})

test('a cursor with a third segment names no row', () => {
  const tampered = Buffer.from(
    `${CURSOR.created_at_cursor}|${CURSOR.run_id}|extra`
  ).toString('base64url')
  assert.strictEqual(decodeRunListCursor(tampered), null)
})

test('a cursor missing either part names no row', () => {
  for (const decoded of [
    `|${CURSOR.run_id}`,
    `${CURSOR.created_at_cursor}|`,
    CURSOR.created_at_cursor,
    ''
  ])
    assert.strictEqual(
      decodeRunListCursor(Buffer.from(decoded).toString('base64url')),
      null,
      decoded
    )
})

test('a cursor whose timestamp cannot be ordered names no row', () => {
  const decoded = `not-a-date|${CURSOR.run_id}`
  assert.strictEqual(
    decodeRunListCursor(Buffer.from(decoded).toString('base64url')),
    null
  )
})
