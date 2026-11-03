import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { readTrajectoryJsonl } from '../shared/trajectory-events.js'

import { buildTrajectoryDocument } from '../browser/features/trajectory/trajectory-model.js'

test('trajectory normalization separates content, reasoning, usage, and tool linkage', () => {
  const document = buildTrajectoryDocument([
    {
      seq: 1,
      event: 'message',
      message: {
        role: 'assistant',
        id: 'assistant-1',
        name: 'issue-single-agent',
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
        response_metadata: {
          model_provider: 'deepseek',
          model_name: 'deepseek-v4-pro'
        },
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 2,
          reasoning_tokens: 1
        }
      }
    },
    {
      seq: 2,
      event: 'message',
      message: {
        role: 'tool',
        id: 'tool-1',
        name: 'read_file',
        tool_call_id: 'call-1',
        content: 'file contents',
        additional_kwargs: {
          diff: 'Index: diff-only/path.ts\n--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n',
          diff_truncated: true
        },
        artifact: { source: 'workspace', truncated: false }
      }
    }
  ])

  assert.strictEqual(document.messages[0]?.content, 'Inspecting the boundary.')
  assert.strictEqual(document.messages[0]?.modelProvider, 'deepseek')
  assert.strictEqual(document.messages[0]?.modelName, 'deepseek-v4-pro')
  assert.match(document.messages[0]?.searchable ?? '', /deepseek-v4-pro/)
  // Assistant names are hidden in the header, so they must not be searchable.
  assert.doesNotMatch(
    document.messages[0]?.searchable ?? '',
    /issue-single-agent/
  )
  // Tool names stay searchable because the header still shows them.
  assert.match(document.messages[1]?.searchable ?? '', /read_file/)
  assert.strictEqual(
    document.messages[0]?.reasoning,
    'Need repository evidence.'
  )
  assert.strictEqual(
    document.messages[0]?.toolCalls[0]?.resultMessageId,
    'tool-1'
  )
  assert.strictEqual(document.messages[1]?.toolCallId, 'call-1')
  assert.match(
    document.messages[0]?.toolCalls[0]?.diff ?? '',
    /^Index: diff-only/
  )
  // The diff is rendered with the call, so its text must be searchable there.
  assert.match(document.messages[0]?.searchable ?? '', /diff-only\/path\.ts/)
  assert.equal(document.messages[0]?.toolCalls[0]?.diffTruncated, true)
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

test('explicit zero cache counters remain known zero', () => {
  const document = buildTrajectoryDocument([
    {
      seq: 1,
      event: 'message',
      message: {
        id: 'fixture-1',
        role: 'assistant',
        content: 'No cache activity.',
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_tokens: null
        }
      }
    }
  ])

  assert.strictEqual(document.messages[0]?.usage?.cacheRead, 0)
  assert.strictEqual(document.messages[0]?.usage?.cacheCreation, 0)
  assert.strictEqual(document.totalUsage.cacheRead, 0)
  assert.strictEqual(document.totalUsage.cacheCreation, 0)
})

test('message-array tool results are not guessed when the ordered run is incomplete', () => {
  const document = buildTrajectoryDocument([
    {
      seq: 1,
      event: 'message',
      message: {
        id: 'fixture-4',
        role: 'assistant',
        tool_calls: [
          { id: 'call-1', name: 'read_file', args: { path: 'a' } },
          { id: 'call-2', name: 'read_file', args: { path: 'b' } }
        ]
      }
    },
    {
      seq: 2,
      event: 'message',
      message: { role: 'tool', id: 'result-1', content: 'unknown result' }
    }
  ])

  assert.strictEqual(
    document.messages[0]?.toolCalls[0]?.resultMessageId,
    undefined
  )
  assert.strictEqual(document.messages[1]?.toolCallId, undefined)
})

test('Responses function calls render once, while unmatched blocks remain inspectable', () => {
  const document = buildTrajectoryDocument([
    {
      seq: 1,
      event: 'message',
      message: {
        id: 'response',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Inspecting.' },
          {
            type: 'function_call',
            call_id: 'ls-1',
            name: 'ls',
            arguments: '{"path":"/workspace"}'
          },
          {
            type: 'function_call',
            call_id: 'unmatched',
            name: 'inspect',
            arguments: '{}'
          }
        ],
        tool_calls: [{ id: 'ls-1', name: 'ls', args: { path: '/workspace' } }]
      }
    }
  ])
  assert.doesNotMatch(document.messages[0]!.content, /ls-1/)
  assert.match(document.messages[0]!.content, /unmatched/)
  assert.deepEqual(document.messages[0]!.toolCalls[0]!.args, {
    path: '/workspace'
  })
})

test('failed analysis fixture preserves empty arguments, errors and repeated prompt provenance', () => {
  const events = readTrajectoryJsonl(
    readFileSync(
      new URL('./fixtures/trajectory-failed-analysis.jsonl', import.meta.url),
      'utf8'
    )
  )
  const document = buildTrajectoryDocument(events)
  const systems = document.messages.filter(
    (message) => message.role === 'system'
  )
  assert.equal(systems.length, 5)
  assert.equal(systems[0]!.repeatedSystemId, undefined)
  assert.ok(
    systems
      .slice(1)
      .every((message) => message.repeatedSystemId === systems[0]!.id)
  )
  const response = document.messages.find((message) => message.seq === 10)!
  assert.equal(response.content, '')
  assert.equal(response.toolCalls.length, 5)
  for (const call of response.toolCalls) {
    assert.deepEqual(call.args, {})
    assert.equal(call.resultStatus, 'error')
    assert.ok(call.resultMessageId)
  }
  const final = document.messages.find((message) => message.seq === 29)!
  assert.deepEqual(final.toolCalls[0]!.args, { path: '/workspace/project/src' })
  assert.equal(final.toolCalls[0]!.resultMessageId, undefined)
})

test('system prompt references never cross branches or skip changed instructions', () => {
  const document = buildTrajectoryDocument([
    {
      seq: 1,
      event: 'message',
      agent: 'agent',
      parent_ids: ['root', 'left', 'model1'],
      message: { id: 'a', role: 'system', content: 'A' }
    },
    {
      seq: 2,
      event: 'message',
      agent: 'agent',
      parent_ids: ['root', 'right', 'model2'],
      message: { id: 'b', role: 'system', content: 'A' }
    },
    {
      seq: 3,
      event: 'message',
      agent: 'agent',
      parent_ids: ['root', 'left', 'model3'],
      message: { id: 'c', role: 'system', content: 'B' }
    },
    {
      seq: 4,
      event: 'message',
      agent: 'agent',
      parent_ids: ['root', 'left', 'model4'],
      message: { id: 'd', role: 'system', content: 'A' }
    },
    {
      seq: 5,
      event: 'message',
      message: { id: 'unknown', role: 'system', content: 'A' }
    }
  ])
  assert.ok(
    document.messages.every((message) => message.repeatedSystemId === undefined)
  )
})
