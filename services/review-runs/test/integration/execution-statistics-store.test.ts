import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Pool } from 'pg'

import { ReviewRunStore } from '../../src/persistence/review-run-store.js'
import { aggregateExecutionStatistics } from '../../src/statistics/execution-statistics.js'
import { ExecutionStatisticsStore } from '../../src/statistics/execution-statistics-store.js'

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (value === undefined)
    throw new Error('A disposable test database is required.')
  return value
}

test('statistics settle only after two identical reads and persist relational groups', async () => {
  const connectorId = `statistics:${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const reviewStore = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await reviewStore.initialize()
  const observer = new Pool({ connectionString: databaseUrl() })
  const statistics = new ExecutionStatisticsStore({
    connectionString: databaseUrl(),
    connectorId,
    claimTimeoutMs: 1_000,
    initialDelayMs: 0,
    settlementWindowMs: 60_000
  })
  try {
    await observer.query(
      `INSERT INTO review_runs
         (run_id,connector_id,workflow,source_platform)
       VALUES ($1,$2,'issue-review','github')`,
      [runId, connectorId]
    )
    await observer.query(
      `INSERT INTO executions
         (run_id,connector_id,status,started_at,finished_at)
       VALUES ($1,$2,'succeeded',clock_timestamp()-interval '61 minutes',clock_timestamp()-interval '1 hour')`,
      [runId, connectorId]
    )
    const snapshot = {
      observationSetHash: 'a'.repeat(64),
      rootTraceCount: 1,
      excludedNonReviewRootCount: 0,
      observedCallCount: 1,
      usageReportedCallCount: 1,
      usageCoverage: 'complete_for_observed_calls' as const,
      tokenUsage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 0
      },
      groups: [
        {
          agentName: 'issue-analyzer',
          caseId: null,
          deliveryId: null,
          agentPhase: 'initial',
          feedbackRetryIndex: null,
          batchIndex: 1,
          chunkId: 'discovery-chunk-0001',
          provider: 'anthropic',
          model: 'deepseek-v4-pro',
          modelCallCount: 1,
          usageReportedCallCount: 1,
          tokenUsage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 0,
            reasoning_tokens: 0
          }
        }
      ]
    }

    const first = await statistics.claimNext()
    assert.ok(first)
    assert.strictEqual(
      await statistics.recordSnapshot(first, snapshot, 0),
      'pending'
    )
    const deadline = await observer.query<{ future: boolean }>(
      `SELECT reconciliation_deadline_at > clock_timestamp() AS future
       FROM execution_statistics WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual(deadline.rows[0]?.future, true)
    const second = await statistics.claimNext()
    assert.ok(second)
    assert.strictEqual(await statistics.recordRateLimit(second, 0), 'pending')
    const third = await statistics.claimNext()
    assert.ok(third)
    assert.strictEqual(await statistics.recordFailure(third, 8, 0), 'pending')
    const failuresBeforeRateLimit = await observer.query<{
      consecutive_failure_count: number
    }>(
      'SELECT consecutive_failure_count FROM execution_statistics WHERE run_id=$1',
      [runId]
    )
    assert.equal(failuresBeforeRateLimit.rows[0]?.consecutive_failure_count, 1)
    const fourth = await statistics.claimNext()
    assert.ok(fourth)
    assert.equal(await statistics.recordRateLimit(fourth, 0), 'pending')
    const failuresAfterRateLimit = await observer.query<{
      consecutive_failure_count: number
    }>(
      'SELECT consecutive_failure_count FROM execution_statistics WHERE run_id=$1',
      [runId]
    )
    assert.equal(failuresAfterRateLimit.rows[0]?.consecutive_failure_count, 1)
    const fifth = await statistics.claimNext()
    assert.ok(fifth)
    assert.strictEqual(
      await statistics.recordSnapshot(fifth, snapshot, 0),
      'settled'
    )

    const total = await observer.query<{
      status: string
      ingestion_status: string
      total_tokens: string
      consecutive_failure_count: number
    }>(
      `SELECT status,ingestion_status,total_tokens::text,consecutive_failure_count
       FROM execution_statistics WHERE run_id=$1`,
      [runId]
    )
    assert.deepStrictEqual(total.rows[0], {
      status: 'settled',
      ingestion_status: 'settled',
      total_tokens: '12',
      consecutive_failure_count: 0
    })
    const groups = await observer.query<{
      agent_name: string
      agent_phase: string
      feedback_retry_index: number | null
      batch_index: number
      chunk_id: string
      provider: string
      model: string
      model_call_count: number
    }>(
      `SELECT agent_name,agent_phase,feedback_retry_index,batch_index,chunk_id,provider,model,model_call_count
       FROM execution_statistics_groups WHERE run_id=$1`,
      [runId]
    )
    assert.deepStrictEqual(groups.rows, [
      {
        agent_name: 'issue-analyzer',
        agent_phase: 'initial',
        feedback_retry_index: null,
        batch_index: 1,
        chunk_id: 'discovery-chunk-0001',
        provider: 'anthropic',
        model: 'deepseek-v4-pro',
        model_call_count: 1
      }
    ])
    const readModel = await reviewStore.queries.getExecutionStatistics([runId])
    assert.deepStrictEqual(readModel.get(runId), {
      reconciliation_status: 'settled',
      ingestion_status: 'settled',
      usage_coverage: 'complete_for_observed_calls',
      root_trace_count: 1,
      excluded_non_review_root_count: 0,
      observed_call_count: 1,
      usage_reported_call_count: 1,
      token_usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 0
      },
      groups: [
        {
          agent_name: 'issue-analyzer',
          case_id: null,
          delivery_id: null,
          agent_phase: 'initial',
          feedback_retry_index: null,
          batch_index: 1,
          chunk_id: 'discovery-chunk-0001',
          provider: 'anthropic',
          model: 'deepseek-v4-pro',
          model_call_count: 1,
          usage_reported_call_count: 1,
          token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 0,
            reasoning_tokens: 0
          }
        }
      ],
      settled_at: (readModel.get(runId) as { settled_at: string }).settled_at,
      updated_at: (readModel.get(runId) as { updated_at: string }).updated_at
    })
    assert.match(readModel.get(runId)?.settled_at ?? '', /^2026-|^20/)
    assert.match(readModel.get(runId)?.updated_at ?? '', /^2026-|^20/)
  } finally {
    await statistics.close()
    await observer.end()
    await reviewStore.close()
  }
})

test('an empty observation set waits for the full window instead of settling as zero usage', async () => {
  const connectorId = `statistics-empty:${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const reviewStore = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await reviewStore.initialize()
  const observer = new Pool({ connectionString: databaseUrl() })
  const statistics = new ExecutionStatisticsStore({
    connectionString: databaseUrl(),
    connectorId,
    claimTimeoutMs: 1_000,
    initialDelayMs: 0,
    settlementWindowMs: 60_000
  })
  const emptySnapshot = {
    observationSetHash: '0'.repeat(64),
    rootTraceCount: 0,
    excludedNonReviewRootCount: 0,
    observedCallCount: 0,
    usageReportedCallCount: 0,
    usageCoverage: 'complete_for_observed_calls' as const,
    tokenUsage: {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null
    },
    groups: []
  }
  try {
    await observer.query(
      `INSERT INTO review_runs
         (run_id,connector_id,workflow,source_platform)
       VALUES ($1,$2,'issue-review','github')`,
      [runId, connectorId]
    )
    await observer.query(
      `INSERT INTO executions
         (run_id,connector_id,status,started_at,finished_at)
       VALUES ($1,$2,'succeeded',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,
      [runId, connectorId]
    )

    const first = await statistics.claimNext()
    assert.ok(first)
    assert.strictEqual(
      await statistics.recordSnapshot(first, emptySnapshot, 0),
      'pending'
    )
    const second = await statistics.claimNext()
    assert.ok(second)
    assert.strictEqual(
      await statistics.recordSnapshot(second, emptySnapshot, 0),
      'pending'
    )

    await observer.query(
      `UPDATE execution_statistics
       SET reconciliation_deadline_at=clock_timestamp()-interval '1 second'
       WHERE run_id=$1`,
      [runId]
    )
    const final = await statistics.claimNext()
    assert.ok(final)
    assert.strictEqual(
      await statistics.recordSnapshot(final, emptySnapshot, 0),
      'no_observations'
    )

    const persisted = await observer.query<{
      status: string
      ingestion_status: string
      usage_coverage: string | null
      total_tokens: string | null
    }>(
      `SELECT status,ingestion_status,usage_coverage,total_tokens::text
       FROM execution_statistics WHERE run_id=$1`,
      [runId]
    )
    assert.deepStrictEqual(persisted.rows[0], {
      status: 'settled',
      ingestion_status: 'no_observations',
      usage_coverage: null,
      total_tokens: null
    })
  } finally {
    await statistics.close()
    await observer.end()
    await reviewStore.close()
  }
})

test('rate limiting concludes at the reconciliation deadline without spending failures', async () => {
  const connectorId = `statistics-rate-limit:${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const reviewStore = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await reviewStore.initialize()
  const observer = new Pool({ connectionString: databaseUrl() })
  const statistics = new ExecutionStatisticsStore({
    connectionString: databaseUrl(),
    connectorId,
    claimTimeoutMs: 1_000,
    initialDelayMs: 0,
    settlementWindowMs: 60_000
  })
  try {
    await observer.query(
      `INSERT INTO review_runs
         (run_id,connector_id,workflow,source_platform)
       VALUES ($1,$2,'issue-review','github')`,
      [runId, connectorId]
    )
    await observer.query(
      `INSERT INTO executions
         (run_id,connector_id,status,started_at,finished_at)
       VALUES ($1,$2,'succeeded',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,
      [runId, connectorId]
    )

    const claimed = await statistics.claimNext()
    assert.ok(claimed)
    await observer.query(
      `UPDATE execution_statistics
       SET reconciliation_deadline_at=clock_timestamp()-interval '1 second'
       WHERE run_id=$1`,
      [runId]
    )

    assert.strictEqual(
      await statistics.recordRateLimit(claimed, 30_000),
      'unavailable'
    )
    const persisted = await observer.query<{
      status: string
      ingestion_status: string
      usage_coverage: string
      failure_code: string
      consecutive_failure_count: number
      settled: boolean
    }>(
      `SELECT status,ingestion_status,usage_coverage,failure_code,consecutive_failure_count,
              settled_at IS NOT NULL AS settled
       FROM execution_statistics WHERE run_id=$1`,
      [runId]
    )
    assert.deepStrictEqual(persisted.rows[0], {
      status: 'unavailable',
      ingestion_status: 'unavailable',
      usage_coverage: 'unavailable',
      failure_code: 'LANGFUSE_RATE_LIMITED',
      consecutive_failure_count: 0,
      settled: true
    })
  } finally {
    await statistics.close()
    await observer.end()
    await reviewStore.close()
  }
})

test('statistics cannot exist without their execution', async () => {
  const connectorId = `statistics-owner:${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const reviewStore = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await reviewStore.initialize()
  const observer = new Pool({ connectionString: databaseUrl() })
  try {
    await observer.query(
      `INSERT INTO review_runs
         (run_id,connector_id,workflow,source_platform)
       VALUES ($1,$2,'issue-review','github')`,
      [runId, connectorId]
    )
    await assert.rejects(
      observer.query(
        `INSERT INTO execution_statistics
           (run_id,status,next_attempt_at,reconciliation_deadline_at)
         VALUES ($1,'pending',clock_timestamp(),clock_timestamp())`,
        [runId]
      ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23503'
    )
    await observer.query(
      `INSERT INTO executions (run_id,connector_id,status)
       VALUES ($1,$2,'pending')`,
      [runId, connectorId]
    )
    await assert.doesNotReject(
      observer.query(
        `INSERT INTO execution_statistics
           (run_id,status,next_attempt_at,reconciliation_deadline_at)
         VALUES ($1,'pending',clock_timestamp(),clock_timestamp())`,
        [runId]
      )
    )
  } finally {
    await observer.query('DELETE FROM review_runs WHERE run_id=$1', [runId])
    await observer.end()
    await reviewStore.close()
  }
})

test('task phases and feedback retries survive snapshot persistence and read projection', async () => {
  const connectorId = `statistics-phases:${randomUUID()}`
  const runId = `run-${randomUUID()}`
  const reviewStore = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId
  })
  await reviewStore.initialize()
  const observer = new Pool({ connectionString: databaseUrl() })
  const statistics = new ExecutionStatisticsStore({
    connectionString: databaseUrl(),
    connectorId,
    claimTimeoutMs: 1_000,
    initialDelayMs: 0,
    settlementWindowMs: 60_000
  })
  try {
    await observer.query(
      "INSERT INTO review_runs (run_id,connector_id,workflow,source_platform) VALUES ($1,$2,'repository-review','github')",
      [runId, connectorId]
    )
    await observer.query(
      "INSERT INTO executions (run_id,connector_id,status,started_at,finished_at) VALUES ($1,$2,'succeeded',clock_timestamp(),clock_timestamp())",
      [runId, connectorId]
    )
    const coordinates = [
      { agent: 'repository-triager', phase: 'draft', retry: null },
      { agent: 'repository-triager', phase: 'refinement', retry: null },
      { agent: 'repository-mitigator', phase: 'initial', retry: null },
      { agent: 'repository-mitigator', phase: 'feedback', retry: 1 },
      { agent: 'repository-mitigator', phase: 'feedback', retry: 2 }
    ]
    const snapshot = aggregateExecutionStatistics({
      roots: [{ id: 'root', traceId: 'trace', metadata: {} }],
      excludedNonReviewRootCount: 0,
      generations: coordinates.map(({ agent, phase, retry }, index) => ({
        id: `generation-${index}`,
        traceId: 'trace',
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
    })
    for (const expected of ['pending', 'settled']) {
      const work = await statistics.claimNext()
      assert.ok(work)
      assert.equal(await statistics.recordSnapshot(work, snapshot, 0), expected)
    }
    const read = (
      await reviewStore.queries.getExecutionStatistics([runId])
    ).get(runId)
    assert.ok(read)
    assert.equal(read.token_usage.total_tokens, 10)
    assert.deepEqual(
      read.groups.map((group) => [
        group.agent_phase,
        group.feedback_retry_index,
        group.model_call_count
      ]),
      [
        ['initial', null, 1],
        ['draft', null, 1],
        ['refinement', null, 1],
        ['feedback', 1, 1],
        ['feedback', 2, 1]
      ]
    )
  } finally {
    await statistics.close()
    await observer.query('DELETE FROM review_runs WHERE run_id=$1', [runId])
    await observer.end()
    await reviewStore.close()
  }
})
