import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { aggregateExecutionStatistics } from '../src/statistics/execution-statistics.js'

test('execution statistics aggregate native provider/model usage by review agent', () => {
  const snapshot = aggregateExecutionStatistics({
    roots: [
      {
        id: 'root-1',
        traceId: 'trace-1',
        metadata: { sec_review_agent: 'issue-analyzer' }
      }
    ],
    generations: [
      {
        id: 'generation-1',
        traceId: 'trace-1',
        model: 'deepseek-v4-pro',
        metadata: {
          sec_review_agent: 'issue-analyzer',
          sec_review_pass_kind: 'initial',
          sec_review_pass_index: '0',
          sec_review_batch_index: '2',
          sec_review_chunk_id: 'discovery-chunk-0002',
          ls_provider: 'anthropic'
        },
        usageDetails: {
          input: 6,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 1,
          output: 2,
          reasoning: 1,
          total: 13
        }
      },
      {
        id: 'generation-2',
        traceId: 'trace-1',
        model: 'deepseek-v4-pro',
        metadata: {
          sec_review_agent: 'issue-analyzer',
          sec_review_pass_kind: 'feedback',
          sec_review_pass_index: '1',
          ls_provider: 'anthropic'
        },
        usageDetails: {
          input: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output: 1,
          reasoning: 0,
          total: 6
        }
      }
    ],
    excludedNonReviewRootCount: 1
  })

  assert.strictEqual(snapshot.observedCallCount, 2)
  assert.strictEqual(snapshot.usageReportedCallCount, 2)
  assert.strictEqual(snapshot.usageCoverage, 'complete_for_observed_calls')
  assert.deepStrictEqual(snapshot.tokenUsage, {
    input_tokens: 15,
    output_tokens: 4,
    total_tokens: 19,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 1,
    reasoning_tokens: 1
  })
  assert.deepStrictEqual(snapshot.groups, [
    {
      agentName: 'issue-analyzer',
      caseId: null,
      deliveryId: null,
      passKind: 'initial',
      passIndex: 0,
      batchIndex: 2,
      chunkId: 'discovery-chunk-0002',
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      modelCallCount: 1,
      usageReportedCallCount: 1,
      tokenUsage: {
        input_tokens: 10,
        output_tokens: 3,
        total_tokens: 13,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
        reasoning_tokens: 1
      }
    },
    {
      agentName: 'issue-analyzer',
      caseId: null,
      deliveryId: null,
      passKind: 'feedback',
      passIndex: 1,
      batchIndex: null,
      chunkId: null,
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      modelCallCount: 1,
      usageReportedCallCount: 1,
      tokenUsage: {
        input_tokens: 5,
        output_tokens: 1,
        total_tokens: 6,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 0
      }
    }
  ])
  assert.match(snapshot.observationSetHash, /^[a-f0-9]{64}$/)
})

test('the total is derived from normalized tokens and a disagreeing source total is reported', () => {
  const warn = mock.method(console, 'warn', () => undefined)
  try {
    const snapshot = aggregateExecutionStatistics({
      roots: [],
      generations: [
        {
          id: 'generation-1',
          traceId: 'trace-1',
          model: 'deepseek-v4-pro',
          metadata: {
            sec_review_agent: 'issue-analyzer',
            ls_provider: 'anthropic'
          },
          usageDetails: {
            input: 6,
            cache_read_input_tokens: 2,
            output: 2,
            // The source total disagrees with its own components; the contract
            // total must be ours, not the source's.
            total: 999
          }
        },
        {
          id: 'generation-2',
          traceId: 'trace-1',
          model: 'deepseek-v4-pro',
          metadata: {
            sec_review_agent: 'issue-analyzer',
            ls_provider: 'anthropic'
          },
          // No source total: the derived total still exists.
          usageDetails: { input: 4, output: 1 }
        }
      ],
      excludedNonReviewRootCount: 0
    })

    assert.deepStrictEqual(snapshot.tokenUsage, {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      // Only one of the two calls reported cache detail, so the subset is null.
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null
    })
    assert.strictEqual(warn.mock.callCount(), 1)
    const message = JSON.parse(
      String(warn.mock.calls[0]?.arguments[0])
    ) as Record<string, unknown>
    assert.strictEqual(
      message.event,
      'execution_statistics_source_total_mismatch'
    )
    assert.strictEqual(message.mismatched_calls, 1)
  } finally {
    warn.mock.restore()
  }
})

test('an empty read reports no observed calls without deciding ingestion', () => {
  const snapshot = aggregateExecutionStatistics({
    roots: [],
    generations: [],
    excludedNonReviewRootCount: 0
  })

  assert.strictEqual(snapshot.observedCallCount, 0)
  assert.strictEqual(snapshot.usageReportedCallCount, 0)
  assert.strictEqual(snapshot.usageCoverage, 'complete_for_observed_calls')
  assert.deepStrictEqual(snapshot.groups, [])
})
