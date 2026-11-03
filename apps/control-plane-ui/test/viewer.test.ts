import assert from 'node:assert/strict'
import test from 'node:test'

import { parseViewerInput } from '../browser/features/viewer/Viewer.js'

test('viewer parses repository trajectory JSONL', () => {
  const events = parseViewerInput(
    [
      JSON.stringify({
        seq: 1,
        event: 'message',
        message: { id: 'fixture-1', role: 'system', content: 'System prompt' }
      }),
      JSON.stringify({
        seq: 2,
        event: 'message',
        message: { id: 'fixture-2', role: 'assistant', content: 'Result' }
      })
    ].join('\n')
  )
  assert.deepStrictEqual(
    events
      .filter((event) => event.event === 'message')
      .map((event) => [event.seq, event.message.role]),
    [
      [1, 'system'],
      [2, 'assistant']
    ]
  )
})

test('viewer rejects arrays, wrappers, legacy roles and malformed records', () => {
  const message = { id: 'm', role: 'user', content: 'Inspect this' }
  for (const value of [
    [message],
    { messages: [message] },
    { events: [] },
    {
      seq: 1,
      event: 'message',
      message: { id: 'm', type: 'human', content: 'old' }
    },
    {
      seq: 1,
      event: 'message',
      message: { role: 'user', content: 'missing ID' }
    }
  ]) {
    assert.throws(() => parseViewerInput(JSON.stringify(value)))
  }
})

test('viewer projects execution events and retains model provenance', () => {
  const records = [
    { seq: 1, event: 'model_calls_start', version: 1 },
    { seq: 2, event: 'model_call_start', call_id: 'call' },
    {
      seq: 3,
      event: 'message',
      call_id: 'call',
      parent_ids: ['root', 'child'],
      metadata: { lc_agent_name: 'researcher' },
      message: {
        id: 'answer',
        role: 'assistant',
        content: 'Evidence',
        usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
      }
    },
    { seq: 4, event: 'model_call_end', call_id: 'call', message_id: 'answer' },
    { seq: 5, event: 'model_calls_end', status: 'completed' }
  ]
  const events = parseViewerInput(
    records.map((record) => JSON.stringify(record)).join('\n')
  )
  assert.equal(events.length, 5)
  assert.equal(events[2]?.call_id, 'call')
  assert.deepEqual(events[2]?.parent_ids, ['root', 'child'])
  assert.throws(
    () => parseViewerInput(JSON.stringify([{ seq: 1, event: 'unrecognized' }])),
    /invalid_trajectory_artifact/
  )
})

test('viewer rejects duplicate identities, unordered records, and inconsistent call references', () => {
  const message = {
    seq: 1,
    event: 'message',
    message: { id: 'm', role: 'assistant', content: 'reply' }
  }
  const encode = (events: unknown[]): string =>
    events.map((event) => JSON.stringify(event)).join('\n')
  for (const records of [
    [message, { ...message, seq: 2 }],
    [message, { ...message, message: { ...message.message, id: 'other' } }],
    [
      { seq: 1, event: 'model_calls_start' },
      { seq: 2, event: 'model_call_end', call_id: 'missing', message_id: 'm' }
    ],
    [{ seq: 1, event: 'model_call_start', call_id: 'no-header' }],
    [
      { seq: 1, event: 'model_calls_start' },
      { seq: 2, event: 'model_calls_end', status: 'failed' },
      { ...message, seq: 3 }
    ]
  ])
    assert.throws(() => parseViewerInput(encode(records)))
})
