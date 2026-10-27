import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregateExecutionStatistics } from '../src/execution-statistics.js'

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
        usageDetails: { input: 10, output: 3, total: 13 }
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
        usageDetails: { input: 5, output: 1, total: 6 }
      }
    ],
    excludedNonReviewRootCount: 1
  })

  assert.strictEqual(snapshot.observedCallCount, 2)
  assert.strictEqual(snapshot.usageReportedCallCount, 2)
  assert.strictEqual(snapshot.usageCoverage, 'complete_for_observed_calls')
  assert.deepStrictEqual(snapshot.tokenUsage, {
    input: 15,
    output: 4,
    total: 19,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    reasoning: null
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
        input: 10,
        output: 3,
        total: 13,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        reasoning: null
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
        input: 5,
        output: 1,
        total: 6,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        reasoning: null
      }
    }
  ])
  assert.match(snapshot.observationSetHash, /^[a-f0-9]{64}$/)
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
