import { expect, test, vi } from 'vitest'

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
          sec_review_agent_phase: 'initial',
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
          sec_review_agent_phase: 'feedback',
          sec_review_feedback_retry_index: '1',
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

  expect(snapshot.observedCallCount).toBe(2)
  expect(snapshot.usageReportedCallCount).toBe(2)
  expect(snapshot.usageCoverage).toBe('complete_for_observed_calls')
  expect(snapshot.tokenUsage).toStrictEqual({
    input_tokens: 15,
    output_tokens: 4,
    total_tokens: 19,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 1,
    reasoning_tokens: 1
  })
  expect(snapshot.groups).toStrictEqual([
    {
      agentName: 'issue-analyzer',
      caseId: null,
      deliveryId: null,
      agentPhase: 'initial',
      feedbackRetryIndex: null,
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
      agentPhase: 'feedback',
      feedbackRetryIndex: 1,
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
  expect(snapshot.observationSetHash).toMatch(/^[a-f0-9]{64}$/)
})

test('the total is derived from normalized tokens and a disagreeing source total is reported', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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

    expect(snapshot.tokenUsage).toStrictEqual({
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      // Only one of the two calls reported cache detail, so the subset is null.
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null
    })
    expect(warn).toHaveBeenCalledTimes(1)
    const message = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >
    expect(message.event).toBe('execution_statistics_source_total_mismatch')
    expect(message.mismatched_calls).toBe(1)
  } finally {
    warn.mockRestore()
  }
})

test('an empty read reports no observed calls without deciding ingestion', () => {
  const snapshot = aggregateExecutionStatistics({
    roots: [],
    generations: [],
    excludedNonReviewRootCount: 0
  })

  expect(snapshot.observedCallCount).toBe(0)
  expect(snapshot.usageReportedCallCount).toBe(0)
  expect(snapshot.usageCoverage).toBe('complete_for_observed_calls')
  expect(snapshot.groups).toStrictEqual([])
})

test('task phases and feedback retries remain separate regardless of observation order', () => {
  const coordinates = [
    { agent: 'repository-triager', phase: 'draft', retry: null },
    { agent: 'repository-triager', phase: 'refinement', retry: null },
    { agent: 'repository-delivery-planner', phase: 'draft', retry: null },
    { agent: 'repository-delivery-planner', phase: 'refinement', retry: null },
    { agent: 'issue-mitigator', phase: 'initial', retry: null },
    { agent: 'issue-mitigator', phase: 'feedback', retry: 1 },
    { agent: 'issue-mitigator', phase: 'feedback', retry: 2 }
  ]
  const generations = coordinates.map(({ agent, phase, retry }, index) => ({
    id: `generation-${index}`,
    traceId: `trace-${index}`,
    model: 'probe-model',
    metadata: {
      sec_review_agent: agent,
      sec_review_agent_phase: phase,
      ...(retry === null
        ? {}
        : { sec_review_feedback_retry_index: String(retry) }),
      ls_provider: 'probe'
    },
    usageDetails: { input: 1, output: 1, total: 2 }
  }))
  const read = { roots: [], generations, excludedNonReviewRootCount: 0 }
  const snapshot = aggregateExecutionStatistics(read)
  expect(snapshot.observedCallCount).toBe(7)
  expect(snapshot.groups).toHaveLength(7)
  expect(snapshot.tokenUsage.total_tokens).toBe(14)
  for (const agent of ['repository-triager', 'repository-delivery-planner']) {
    expect(
      snapshot.groups
        .filter((group) => group.agentName === agent)
        .map((group) => [
          group.agentPhase,
          group.feedbackRetryIndex,
          group.modelCallCount
        ])
    ).toStrictEqual([
      ['draft', null, 1],
      ['refinement', null, 1]
    ])
  }
  expect(
    snapshot.groups
      .filter((group) => group.agentName === 'issue-mitigator')
      .map((group) => [
        group.agentPhase,
        group.feedbackRetryIndex,
        group.modelCallCount
      ])
  ).toStrictEqual([
    ['initial', null, 1],
    ['feedback', 1, 1],
    ['feedback', 2, 1]
  ])
  expect(
    aggregateExecutionStatistics({
      ...read,
      generations: [...generations].reverse()
    })
  ).toStrictEqual(snapshot)
})
