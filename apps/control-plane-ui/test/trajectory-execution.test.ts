import { trajectoryCorpus } from './contract-fixtures.js'
import { expect, test } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { parseViewerInput } from '../browser/features/viewer/Viewer.js'
import { readTrajectoryArtifact } from '../server/memory/trajectory-artifact.js'
import {
  buildTrajectoryDocument,
  type TrajectoryEvent
} from '../browser/features/trajectory/trajectory-model.js'

test('memory artifact reader keeps messages and validates execution record ordering', () => {
  const records = [
    { seq: 1, event: 'model_calls_start', version: 1 },
    { seq: 2, event: 'model_call_start', call_id: 'call' },
    {
      seq: 3,
      event: 'message',
      call_id: 'call',
      parent_ids: ['root'],
      source: 'summarization',
      message: { id: 'answer', role: 'assistant', content: 'Summary' }
    },
    { seq: 4, event: 'model_call_end', call_id: 'call', message_id: 'answer' },
    { seq: 5, event: 'model_calls_end', status: 'completed' }
  ]
  const encode = (items: unknown[]): Buffer =>
    zstdCompressSync(
      Buffer.from(items.map((item) => JSON.stringify(item)).join('\n'))
    )
  const events = readTrajectoryArtifact(encode(records))
  expect(events.length).toBe(5)
  expect(events[2]?.source).toBe('summarization')
  expect(() =>
    readTrajectoryArtifact(encode([...records, records[0]]))
  ).toThrow(/invalid_trajectory_artifact/)
})

test('parallel subagents with repeated tool IDs link to their own results', () => {
  const events: TrajectoryEvent[] = ['left', 'right'].flatMap(
    (branch, index) => [
      {
        seq: index * 2 + 1,
        event: 'message',
        call_id: `${branch}-model`,
        parent_ids: ['root', branch, 'model'],
        agent: branch,
        message: {
          id: `${branch}-call`,
          role: 'assistant',
          tool_calls: [{ id: 'same-tool-id', name: 'inspect', args: {} }],
          content: '',
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            reasoning_tokens: null
          }
        }
      },
      {
        seq: index * 2 + 2,
        event: 'message',
        parent_ids: ['root', branch, 'tools'],
        message: {
          id: `${branch}-result`,
          role: 'tool',
          tool_call_id: 'same-tool-id',
          content: branch
        }
      }
    ]
  )
  events.unshift({
    seq: 0,
    event: 'message',
    message: {
      id: 'historical-response',
      role: 'assistant',
      content: 'Prior invocation',
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        reasoning_tokens: null
      }
    }
  })
  events.unshift({ seq: 1, event: 'model_calls_start' })
  for (const branch of ['left', 'right']) {
    events.splice(1, 0, {
      seq: 1,
      event: 'model_call_start',
      call_id: `${branch}-model`
    })
  }
  events.forEach((event, index) => {
    event.seq = index + 1
  })
  const document = buildTrajectoryDocument(events)
  expect(document.totalUsage.total).toBe(24)
  for (const branch of ['left', 'right']) {
    const message = document.messages.find(
      (message) => message.id === `${branch}-call`
    )
    expect(message?.toolCalls[0]?.resultMessageId).toBe(`${branch}-result`)
    expect(message?.agent).toBe(branch)
  }
})

test('runtime fixtures preserve flat conversation order and identify subagents and summarization', () => {
  for (const [name, tokens] of [
    ['subagents', 4868],
    ['summarization', 4105]
  ] as const) {
    const raw = trajectoryCorpus(`${name}.jsonl`)
    const events = readTrajectoryArtifact(zstdCompressSync(Buffer.from(raw)))
    expect(parseViewerInput(raw)).toStrictEqual(events)
    const document = buildTrajectoryDocument(events)
    expect(
      document.messages.slice(0, 2).map((message) => message.role)
    ).toStrictEqual(['system', 'human'])
    expect(document.totalUsage.total).toBe(tokens)
    if (name === 'subagents') {
      for (const agent of ['source-reviewer', 'test-reviewer']) {
        const branch = document.messages.filter(
          (message) => message.agent === agent
        )
        expect(branch.slice(0, 2).map((message) => message.role)).toStrictEqual(
          ['system', 'human']
        )
        expect.assert(
          branch
            .flatMap((message) => message.toolCalls)
            .every((call) => call.resultMessageId)
        )
      }
    } else {
      const summary = document.messages.filter(
        (message) => message.source === 'summarization'
      )
      expect(summary.map((message) => message.role)).toStrictEqual([
        'human',
        'assistant',
        'human'
      ])
      expect(summary[0]?.content ?? '').toMatch(/src\/download.py/)
    }
  }
})

test('viewer and memory artifact readers enforce the trajectory contract corpus', async () => {
  const { trajectoryManifest } = await import('./contract-fixtures.js')
  const manifest = trajectoryManifest()
  for (const name of manifest.valid) {
    const input = trajectoryCorpus(name)
    expect(parseViewerInput(input), name).toStrictEqual(
      readTrajectoryArtifact(zstdCompressSync(Buffer.from(input)))
    )
  }
  for (const name of manifest.invalid) {
    const input = trajectoryCorpus(name)
    expect(() => parseViewerInput(input), name).toThrow()
    expect(
      () => readTrajectoryArtifact(zstdCompressSync(Buffer.from(input))),
      name
    ).toThrow()
  }
})

for (const provenance of ['ancestry', 'agent', 'both'] as const) {
  test(`an unanswered tool call cannot use a sibling result (${provenance})`, () => {
    const context = (
      branch: string,
      node: string
    ): Pick<TrajectoryEvent, 'parent_ids' | 'agent'> => ({
      ...(provenance !== 'agent' ? { parent_ids: ['root', branch, node] } : {}),
      ...(provenance !== 'ancestry' ? { agent: branch } : {})
    })
    const document = buildTrajectoryDocument([
      ...['left', 'right'].map((branch, index): TrajectoryEvent => ({
        seq: index + 1,
        event: 'message',
        ...context(branch, 'model'),
        message: {
          id: `${branch}-request`,
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'same', name: 'edit', args: {} }]
        }
      })),
      {
        seq: 3,
        event: 'message',
        ...context('right', 'tools'),
        message: {
          id: 'right-result',
          role: 'tool',
          tool_call_id: 'same',
          content: 'Success',
          additional_kwargs: { diff: 'sibling-only-diff' }
        }
      }
    ])
    const left = document.messages[0]!
    expect(left.toolCalls[0]?.resultMessageId).toBe(undefined)
    expect(left.toolCalls[0]?.diff).toBe(undefined)
    expect(left.searchable).not.toMatch(/sibling-only-diff/)
    expect(document.messages[1]?.toolCalls[0]?.resultMessageId).toBe(
      'right-result'
    )
  })
}

test('a result shared by indistinguishable requests remains unresolved', () => {
  const events: TrajectoryEvent[] = ['first', 'second'].map((id, index) => ({
    seq: index + 1,
    event: 'message',
    message: {
      id,
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'same', name: 'edit', args: {} }]
    }
  }))
  events.push({
    seq: 3,
    event: 'message',
    message: {
      id: 'result',
      role: 'tool',
      content: 'Success',
      tool_call_id: 'same',
      additional_kwargs: { diff: 'ambiguous-diff' }
    }
  })
  const document = buildTrajectoryDocument(events)
  for (const message of document.messages.slice(0, 2)) {
    expect(message.toolCalls[0]?.resultMessageId).toBe(undefined)
    expect(message.toolCalls[0]?.diff).toBe(undefined)
    expect(message.searchable).not.toMatch(/ambiguous-diff/)
  }
})

for (const ended of [true, false]) {
  test(`multiple response observations count only an identified response (ended=${ended})`, () => {
    const records = [
      { event: 'model_calls_start' },
      { event: 'model_call_start', call_id: 'c' },
      ...[12, 13].map((total) => ({
        event: 'message',
        call_id: 'c',
        message: {
          id: `response-${total}`,
          role: 'assistant',
          content: 'Reply',
          usage_metadata: {
            input_tokens: total - 1,
            output_tokens: 1,
            total_tokens: total,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            reasoning_tokens: null
          }
        }
      })),
      ...(ended
        ? [{ event: 'model_call_end', call_id: 'c', message_id: 'response-13' }]
        : [])
    ]
    const input = records
      .map((record, index) => JSON.stringify({ seq: index + 1, ...record }))
      .join('\n')
    const document = buildTrajectoryDocument(parseViewerInput(input))
    expect(document.totalUsage.total).toBe(ended ? 13 : undefined)
    expect(document.messages.length).toBe(2)
  })
}

test('an interrupted call with one recorded response retains known usage', () => {
  const input = [
    { seq: 1, event: 'model_calls_start' },
    { seq: 2, event: 'model_call_start', call_id: 'c' },
    {
      seq: 3,
      event: 'message',
      call_id: 'c',
      message: {
        id: 'response',
        role: 'assistant',
        content: 'Reply',
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          reasoning_tokens: null
        }
      }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
  expect(
    buildTrajectoryDocument(parseViewerInput(input)).totalUsage.total
  ).toBe(12)
})

test('a missing call usage keeps aggregate fields unknown independently', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 0
  }
  const records = [
    { event: 'model_calls_start' },
    { event: 'model_call_start', call_id: 'first' },
    {
      event: 'message',
      call_id: 'first',
      message: {
        id: 'a',
        role: 'assistant',
        content: '',
        usage_metadata: usage
      }
    },
    { event: 'model_call_end', call_id: 'first', message_id: 'a' },
    { event: 'model_call_start', call_id: 'missing' },
    { event: 'model_calls_end', status: 'interrupted' }
  ]
  const events = parseViewerInput(
    records
      .map((record, index) => JSON.stringify({ seq: index + 1, ...record }))
      .join('\n')
  )
  const document = buildTrajectoryDocument(events)
  expect(document.messages[0]?.usage?.total).toBe(12)
  expect(document.totalUsage.total).toBe(undefined)
  expect(document.totalUsage.input).toBe(undefined)
  expect(document.totalUsage.cacheRead).toBe(undefined)
  const oneCall = buildTrajectoryDocument(events.slice(0, 4))
  expect(oneCall.totalUsage.total).toBe(12)
  expect(oneCall.totalUsage.cacheRead).toBe(undefined)
  expect(oneCall.totalUsage.cacheCreation).toBe(0)
})
