import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTranscript } from '../browser/features/transcript/transcript-model.js'

test('transcript normalization separates content, reasoning, usage, and tool linkage', () => {
  const document = normalizeTranscript([
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        id: 'assistant-1',
        content: [
          { type: 'text', text: 'Inspecting the boundary.' },
          { type: 'thinking', thinking: 'Need repository evidence.' },
          {
            type: 'tool_use',
            name: 'read_file',
            input: { path: '/workspace/a' }
          }
        ],
        tool_calls: [
          {
            id: 'call-1',
            name: 'read_file',
            args: { path: '/workspace/a' }
          }
        ],
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_token_details: {
            cache_read: 7,
            cache_creation: 2
          },
          output_token_details: { reasoning: 1 }
        }
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        type: 'tool',
        id: 'tool-1',
        name: 'read_file',
        tool_call_id: 'call-1',
        content: 'file contents',
        artifact: { source: 'workspace', truncated: false }
      }
    }
  ])

  assert.strictEqual(document.messages[0]?.content, 'Inspecting the boundary.')
  assert.strictEqual(
    document.messages[0]?.reasoning,
    'Need repository evidence.'
  )
  assert.strictEqual(
    document.messages[0]?.toolCalls[0]?.resultMessageId,
    'tool-1'
  )
  assert.strictEqual(document.messages[1]?.toolCallId, 'call-1')
  assert.deepStrictEqual(document.messages[1]?.artifact, {
    source: 'workspace',
    truncated: false
  })
  assert.strictEqual(document.totalUsage.total, 15)
  assert.strictEqual(document.totalUsage.input, 10)
  assert.strictEqual(document.totalUsage.output, 5)
  assert.strictEqual(document.totalUsage.cacheRead, 7)
  assert.strictEqual(document.totalUsage.cacheCreation, 2)
  assert.strictEqual(document.totalUsage.reasoning, 1)
})

test('zero cache counters are treated as absent usage details', () => {
  const document = normalizeTranscript([
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        content: 'No cache activity.',
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          input_token_details: { cache_read: 0, cache_creation: 0 }
        }
      }
    }
  ])

  assert.strictEqual(document.messages[0]?.usage?.cacheRead, undefined)
  assert.strictEqual(document.messages[0]?.usage?.cacheCreation, undefined)
  assert.strictEqual(document.totalUsage.cacheRead, undefined)
  assert.strictEqual(document.totalUsage.cacheCreation, undefined)
})

test('raw provider cache buckets become inclusive transcript input', () => {
  const document = normalizeTranscript([
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        content: 'Provider response metadata.',
        response_metadata: {
          usage: {
            input_tokens: 6,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 1,
            output_tokens: 5,
            total_tokens: 15
          }
        }
      }
    }
  ])

  assert.deepStrictEqual(document.messages[0]?.usage, {
    input: 10,
    output: 5,
    cacheRead: 3,
    cacheCreation: 1,
    total: 15,
    reasoning: undefined
  })
})

test('ordered message-array tool results link when the complete run is unambiguous', () => {
  const document = normalizeTranscript([
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        tool_calls: [
          { id: 'call-1', name: 'read_file', args: { path: 'a' } },
          { id: 'call-2', name: 'read_file', args: { path: 'b' } }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: { type: 'tool', id: 'result-1', content: 'a' }
    },
    {
      seq: 3,
      event: 'message',
      message: { type: 'tool', id: 'result-2', content: 'b' }
    }
  ])

  assert.strictEqual(
    document.messages[0]?.toolCalls[0]?.resultMessageId,
    'result-1'
  )
  assert.strictEqual(
    document.messages[0]?.toolCalls[1]?.resultMessageId,
    'result-2'
  )
  assert.strictEqual(document.messages[1]?.toolCallId, 'call-1')
  assert.strictEqual(document.messages[2]?.toolCallId, 'call-2')
})

test('message-array tool results are not guessed when the ordered run is incomplete', () => {
  const document = normalizeTranscript([
    {
      seq: 1,
      event: 'message',
      message: {
        type: 'ai',
        tool_calls: [
          { id: 'call-1', name: 'read_file', args: { path: 'a' } },
          { id: 'call-2', name: 'read_file', args: { path: 'b' } }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: { type: 'tool', id: 'result-1', content: 'unknown result' }
    }
  ])

  assert.strictEqual(
    document.messages[0]?.toolCalls[0]?.resultMessageId,
    undefined
  )
  assert.strictEqual(document.messages[1]?.toolCallId, undefined)
})
