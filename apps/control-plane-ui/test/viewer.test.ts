import assert from 'node:assert/strict'
import test from 'node:test'

import { parseViewerInput } from '../browser/features/viewer/Viewer.js'

test('viewer parses repository transcript JSONL', () => {
  const events = parseViewerInput(
    [
      JSON.stringify({
        seq: 1,
        event: 'message',
        message: { type: 'system', content: 'System prompt' }
      }),
      JSON.stringify({
        seq: 2,
        event: 'message',
        message: { type: 'ai', content: 'Result' }
      })
    ].join('\n')
  )
  assert.deepStrictEqual(
    events.map((event) => [event.seq, event.message.type]),
    [
      [1, 'system'],
      [2, 'ai']
    ]
  )
})

test('viewer wraps raw message arrays as transcript events', () => {
  const events = parseViewerInput(
    JSON.stringify({ messages: [{ type: 'human', content: 'Inspect this' }] })
  )
  assert.strictEqual(events[0]?.seq, 1)
  assert.strictEqual(events[0]?.message.type, 'human')
})

test('viewer rejects unrelated JSON objects', () => {
  assert.throws(() => parseViewerInput('{"status":"ok"}'), /no_messages/)
})
