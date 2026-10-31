// Exercises the PostgreSQL-backed coordination state machines, including their
// claim fencing and cross-connector ownership rules.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

import {
  concludeExhaustedSubmissionRecovery,
  MAX_SUBMISSION_RECOVERY_ATTEMPTS,
  recoverReviewRunSubmission
} from '../../src/runtime/submission-recovery.js'
import { coordinateReviewRunsOnce } from '../../src/runtime/coordinator.js'
import { submitPreparedRun } from '../../src/runtime/prepared-submission.js'
import { ReviewRunStore } from '../../src/persistence/review-run-store.js'
import type { ExecutionArtifactStorage } from '../../src/contracts.js'
import { ExecutionSubmissionUncertainError } from '../../src/execution-client.js'

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

function connectorId(): string {
  return `test:${randomUUID()}`
}

async function createStore(
  options: { connectorId?: string; claimTimeoutMs?: number } = {}
): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: options.connectorId ?? connectorId(),
    ...(options.claimTimeoutMs === undefined
      ? {}
      : { claimTimeoutMs: options.claimTimeoutMs })
  })
  await store.initialize()
  return store
}

/** Freeze the input-publication prerequisite for tests of the later execution/recovery axis.
 * Future claimed_at is intentional: these tests use a zero timeout to expire recovery leases,
 * but the initial preparation must still be alive while publishing its input. */
async function publishedInput(
  store: ReviewRunStore,
  runId: string,
  token: string,
  input: Record<string, unknown>,
  context: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    await pool.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()+interval '1 minute'
      WHERE run_id=$1 AND status='preparing' AND claim_token=$2`,
      [runId, token]
    )
  } finally {
    await pool.end()
  }
  input.input_bundle = {
    uri: `file:///tmp/${runId}.tar.zst`,
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 1
  }
  const candidate = await store.inputBundleCandidates.reserve(runId, token, {
    reference: input.input_bundle as {
      uri: string
      digest: string
      media_type: 'application/tar+zstd'
      size_bytes: number
    },
    input,
    publish_context: context
  })
  await store.inputBundleCandidates.settle(
    runId,
    token,
    candidate.digest,
    'present'
  )
  return input
}

async function createQueuedRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  const context = {}
  const admission = await store.admissions.create({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.submissionTransitions.markQueued(
    runId,
    admission.preparation_token,
    context
  )
  return runId
}

async function createSuccessfulRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  await createQueuedRun(store, runId)
  assert.strictEqual(
    await store.executions.recordExecutionSuccess(
      runId,
      { run_id: runId },
      { status: 'unavailable' }
    ),
    true
  )
  return runId
}

test('ReviewRunStore prevents cross-connector access to a globally unique run identity', async () => {
  const connectorA = connectorId()
  const connectorB = connectorId()
  const runId = `run-shared-${randomUUID()}`
  const first = await createStore({ connectorId: connectorA })
  const second = await createStore({ connectorId: connectorB })
  try {
    await createQueuedRun(first, runId)

    assert.strictEqual((await first.queries.getRun(runId))?.run_id, runId)
    // run_id is currently a global primary key, while connector_id fences
    // reads and claims. A second connector must not create or see the first
    // connector's run under that identity.
    await assert.rejects(
      createQueuedRun(second, runId),
      /duplicate key value violates unique constraint/
    )
    assert.strictEqual(await second.queries.getRun(runId), null)
    assert.strictEqual((await first.queries.listActiveRuns()).runs.length, 1)
    assert.strictEqual((await second.queries.listActiveRuns()).runs.length, 0)
    assert.strictEqual(await first.publicationClaims.claim(runId), null)
    await first.executions.recordExecutionSuccess(
      runId,
      { run_id: runId },
      { status: 'unavailable' }
    )
    assert.notStrictEqual(await first.publicationClaims.claim(runId), null)
    assert.strictEqual(await second.publicationClaims.claim(runId), null)
    // The event log is fenced by the same connector as every other read. A second connector
    // reading the identity it cannot own must get an empty list, not another tenant's
    // transitions, so the history view can never cross a connector boundary.
    assert.ok((await first.queries.listEvents(runId)).length > 0)
    assert.deepStrictEqual(await second.queries.listEvents(runId), [])
  } finally {
    await first.close()
    await second.close()
  }
})

test('ReviewRunStore persists queued runs and keeps preparing runs out of polling', async () => {
  const store = await createStore()
  try {
    const queuedId = await createQueuedRun(store)
    const artifactStorage: ExecutionArtifactStorage = {
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: `s3://sec-review/runs/${queuedId}/artifacts/diagnostic-tree.v1.tar.zst`,
        media_type: 'application/tar+zstd',
        digest: `sha256:${'a'.repeat(64)}`,
        size_bytes: 123
      }
    }
    await store.executions.recordArtifactStorage(queuedId, artifactStorage)
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const queued = await store.queries.getRun(queuedId)
    assert.strictEqual(queued?.execution.status, 'queued')
    assert.deepStrictEqual(queued?.artifact_storage, artifactStorage)
    assert.deepStrictEqual(
      (await store.queries.listActiveRuns()).runs.map((entry) => entry.run_id),
      [queuedId]
    )
  } finally {
    await store.close()
  }
})

test('execution.started_at marks the instant execution began and does not move afterwards', async () => {
  const store = await createStore()
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const runId = admission.record.run_id
    assert.ok(admission.preparation_token)

    // Before submission the run is still preparing: there is no execution start to report.
    assert.strictEqual(
      (await store.queries.getRun(runId))?.execution.started_at,
      null
    )

    await store.submissionTransitions.markQueued(
      runId,
      admission.preparation_token,
      {}
    )
    const queued = await store.queries.getRun(runId)
    assert.ok(queued?.execution.started_at)
    const submittedAt = queued?.execution.started_at

    // A later, non-transitional write (the artifact mtime) must not move the start.
    await store.executions.recordArtifactStorage(runId, {
      status: 'unavailable'
    })
    const after = await store.queries.getRun(runId)
    assert.strictEqual(after?.execution.started_at, submittedAt)
    assert.ok(
      Date.parse(after!.execution.updated_at) >= Date.parse(submittedAt!),
      'the row mtime moves past the immutable execution start'
    )
  } finally {
    await store.close()
  }
})

test('execution termination events name the state they came from', async () => {
  const store = await createStore()
  try {
    // running -> succeeded must record from_status 'running', not null. `null` is reserved for
    // the first event on an axis, so a null here would make the timeline claim the run started
    // at that point.
    const succeededId = await createQueuedRun(store)
    await store.executions.markRunning(succeededId)
    assert.strictEqual(
      await store.executions.recordExecutionSuccess(
        succeededId,
        { run_id: succeededId },
        undefined
      ),
      true
    )
    const succeededEvents = (
      await store.queries.listEvents(succeededId)
    ).filter((event) => event.axis === 'execution')
    assert.deepStrictEqual(
      succeededEvents.map((event) => [event.from_status, event.to_status]),
      [
        [null, 'pending'],
        ['pending', 'queued'],
        ['queued', 'running'],
        ['running', 'succeeded']
      ]
    )

    // queued -> failed likewise records the real origin.
    const failedId = await createQueuedRun(store)
    assert.strictEqual(
      await store.failExecution(failedId, {
        code: 'EXECUTION_FAILED',
        message: 'boom'
      }),
      true
    )
    const failedEvents = (await store.queries.listEvents(failedId)).filter(
      (event) => event.axis === 'execution'
    )
    assert.deepStrictEqual(
      failedEvents.map((event) => [event.from_status, event.to_status]),
      [
        [null, 'pending'],
        ['pending', 'queued'],
        ['queued', 'failed']
      ]
    )
  } finally {
    await store.close()
  }
})

test('the coordination event log records each transition once, oldest first', async () => {
  const store = await createStore()
  try {
    const runId = await createQueuedRun(store)
    // At least the admission (execution pending, preparation preparing, publication pending)
    // and the pending->queued + preparing->submitted transitions must be present.
    const events = await store.queries.listEvents(runId)
    const axes = events.map((event) => `${event.axis}:${event.to_status}`)
    assert.ok(axes.includes('execution:pending'))
    assert.ok(axes.includes('preparation:preparing'))
    assert.ok(axes.includes('publication:pending'))
    assert.ok(axes.includes('execution:queued'))
    assert.ok(axes.includes('preparation:submitted'))

    // Oldest first, and each transition appears exactly once.
    const times = events.map((event) => Date.parse(event.occurred_at))
    assert.deepStrictEqual(
      times,
      [...times].sort((a, b) => a - b)
    )
    assert.strictEqual(
      new Set(events.map((event) => event.event_id)).size,
      events.length
    )
  } finally {
    await store.close()
  }
})

test('touchObservation advances the row mtime without changing state', async () => {
  const store = await createStore()
  try {
    const runId = await createQueuedRun(store)
    const before = await store.queries.getRun(runId)
    assert.strictEqual(before?.execution.status, 'queued')
    // The heartbeat must move the mtime forward even though the status is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.executions.touchObservation(runId)
    const after = await store.queries.getRun(runId)
    assert.strictEqual(after?.execution.status, 'queued', 'state is unchanged')
    assert.ok(
      Date.parse(after!.execution.updated_at) >
        Date.parse(before!.execution.updated_at),
      'the row mtime moved forward'
    )
    // It must not touch a run that is not being polled.
    const admitted = await store.admissions.create({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const preparingBefore = admitted.record.execution.updated_at
    await store.executions.touchObservation(admitted.record.run_id)
    assert.strictEqual(
      (await store.queries.getRun(admitted.record.run_id))?.execution
        .updated_at,
      preparingBefore,
      'a pending run is not touched'
    )
  } finally {
    await store.close()
  }
})

test('heartbeats do not refresh an expired recovery lease', async () => {
  // The precise invariant a zero timeout cannot express: with a real timeout, keep heartbeating
  // past the lease deadline and the claim must STILL be reclaimable. This fails if the lease is
  // ever computed from observed_at (which the heartbeat moves) instead of claimed_at.
  const store = await createStore({
    connectorId: `lease-live:${randomUUID()}`,
    claimTimeoutMs: 300
  })
  try {
    const runId = `run-lease-live-${randomUUID()}`
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await assert.rejects(
      submitPreparedRun(
        store,
        {
          runId,
          preparationToken: admission.preparation_token,
          publishContext: {},
          input: await publishedInput(
            store,
            runId,
            admission.preparation_token,
            {}
          )
        },
        async () => {
          throw new ExecutionSubmissionUncertainError('response lost')
        }
      ),
      ExecutionSubmissionUncertainError
    )
    const first = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(first)

    // Heartbeat repeatedly past the 300ms lease. If the lease were observed_at-based, these
    // heartbeats would keep the claim alive and the reclaim below would return null.
    const deadline = Date.now() + 600
    while (Date.now() < deadline) {
      await store.executions.touchObservation(runId)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const second = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(
      second,
      'the expired recovery claim is reclaimable despite heartbeats'
    )
    assert.notStrictEqual(
      second,
      first,
      'reclaiming issues a new fencing token'
    )
  } finally {
    await store.close()
  }
})

test('an observation heartbeat never extends the recovery lease', async () => {
  // The recovery lease reads claimed_at; the heartbeat writes observed_at only. This test
  // holds the execution in `uncertain` and shows that one claim, followed by heartbeats, does
  // not keep the claim alive forever: a zero-timeout store can reclaim it immediately.
  const sharedConnector = `lease:${randomUUID()}`
  const runId = `run-lease-${randomUUID()}`
  const store = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await assert.rejects(
      submitPreparedRun(
        store,
        {
          runId,
          preparationToken: admission.preparation_token,
          publishContext: {},
          input: await publishedInput(
            store,
            runId,
            admission.preparation_token,
            {}
          )
        },
        async () => {
          throw new ExecutionSubmissionUncertainError('response lost')
        }
      ),
      ExecutionSubmissionUncertainError
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.execution.status,
      'uncertain'
    )

    const first = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(first)
    // Heartbeats would, under a shared updated_at lease, refresh the recovery lease. With
    // observed_at separate they must not; a zero timeout lets us observe that directly.
    await store.executions.touchObservation(runId)
    const second = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(second, 'the expired recovery claim is reclaimable')
    assert.notStrictEqual(
      second,
      first,
      'reclaiming issues a new fencing token'
    )
  } finally {
    await store.close()
  }
})

test('a failure notice reports the reason captured when it was created', async () => {
  // The delivery path used to read `preparations.failure_code` at claim time. That row is the
  // live state machine and a retry clears its failure fields, so the user-visible reason could
  // degrade to a generic fallback depending on later writes. The outbox now stores its own copy.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.preparations.fail(runId, admission.preparation_token, {
      code: 'REVIEW_START_FAILED',
      message: 'preparation could not start'
    })
    const notice = await store.notices.claimNext()
    assert.ok(notice)
    assert.strictEqual(notice.reason_code, 'REVIEW_START_FAILED')

    // Rewriting the preparation row must not change what the notice reports.
    const pool = new Pool({ connectionString: requireTestDatabase() })
    try {
      await pool.query(
        'UPDATE preparations SET failure_code=NULL WHERE run_id=$1',
        [runId]
      )
    } finally {
      await pool.end()
    }
    const stillReported = await store.queries.getRun(runId)
    assert.strictEqual(
      (stillReported?.preparation as { failure_code: string | null })
        .failure_code,
      null,
      'the preparation row really lost its code'
    )
    // The notice already claimed above keeps its own copy; a fresh claim after the lease expires
    // must also report it rather than the now-null preparation field.
    const pool2 = new Pool({ connectionString: requireTestDatabase() })
    try {
      await pool2.query(
        `UPDATE run_notices
           SET status='pending', claim_token=NULL, claimed_at=NULL WHERE run_id=$1`,
        [runId]
      )
    } finally {
      await pool2.end()
    }
    const reclaimed = await store.notices.claimNext()
    assert.ok(reclaimed)
    assert.strictEqual(
      reclaimed.reason_code,
      'REVIEW_START_FAILED',
      "the notice carries its own reason, not the preparation row's current value"
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore turns an expired preparation uncertain without failing its run', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-stale-preparation-${randomUUID()}`
  try {
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })

    assert.strictEqual((await store.preparations.expireStale()).concluded, 1)
    const run = await store.queries.getRun(runId)
    assert.strictEqual(run?.execution.status, 'pending')
    assert.strictEqual(run?.failure_code, null)
    // The lease lapsed, so nobody knows how far the preparer got: that is uncertainty, not a
    // return to "never started".
    assert.strictEqual(run?.preparation?.status, 'uncertain')
    assert.strictEqual(run?.preparation?.attempt_count, 1)
    assert.deepStrictEqual(run?.notices, [])
    assert.strictEqual(await store.publicationClaims.claim(runId), null)
    assert.strictEqual((await store.preparations.expireStale()).concluded, 0)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore exhausts a preparation whose final claim lease expires', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-exhausted-preparation-${randomUUID()}`
  try {
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await observer.query(
      `UPDATE preparations SET attempt_count=8,
        claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual((await store.preparations.expireStale()).concluded, 1)
    const run = await store.queries.getRun(runId)
    assert.strictEqual(run?.execution.status, 'skipped')
    assert.strictEqual(run?.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.deepStrictEqual(
      {
        status: run?.preparation?.status,
        attempt_count: run?.preparation?.attempt_count,
        failure_code: run?.preparation?.failure_code,
        notice_status: run?.notices?.[0]?.status,
        notice_axis: run?.notices?.[0]?.axis
      },
      {
        status: 'failed',
        attempt_count: 8,
        failure_code: 'PREPARATION_RETRY_EXHAUSTED',
        notice_status: 'pending',
        notice_axis: 'preparation'
      }
    )
    assert.strictEqual(await store.preparations.claimNext(), null)
    assert.strictEqual(await store.publicationClaims.claim(runId), null)
    const notice = await store.notices.claimNext()
    assert.ok(notice)
    assert.strictEqual(notice.run_id, runId)
    assert.deepStrictEqual(notice.input, {})
    assert.strictEqual(notice.reason_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.strictEqual(
      (await store.queries.getRun(runId))?.notices?.[0]?.status,
      'delivering'
    )
    assert.strictEqual(
      // A stale claim is rejected, not thrown at: the delivery is well-formed, it simply no
      // longer owns the notice.
      await store.notices.complete(
        notice.notice_id,
        randomUUID(),
        true,
        'https://github.com/example/example/issues/1#issuecomment-1'
      ),
      false
    )
    assert.strictEqual(
      await store.notices.complete(
        notice.notice_id,
        notice.claim_token,
        true,
        'https://github.com/example/example/issues/1#issuecomment-1'
      ),
      true
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.notices?.[0]?.status,
      'delivered'
    )
    assert.strictEqual(await store.notices.claimNext(), null)
  } finally {
    await observer.end()
    await store.close()
  }
})

test('concurrent failure notice consumers cannot own the same outbox work', async () => {
  // The notice is created by the same terminal preparation transition production
  // uses. Its `FOR UPDATE ... SKIP LOCKED` claim must give only one connector
  // process the acknowledgement work.
  const sharedConnector = `notice:${randomUUID()}`
  const producer = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const first = await createStore({ connectorId: sharedConnector })
  const second = await createStore({ connectorId: sharedConnector })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-concurrent-notice-${randomUUID()}`
  try {
    await producer.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await observer.query(
      `UPDATE preparations SET attempt_count=8,
        claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual((await producer.preparations.expireStale()).concluded, 1)

    const claims = await Promise.all([
      first.notices.claimNext(),
      second.notices.claimNext()
    ])
    assert.strictEqual(claims.filter((claim) => claim !== null).length, 1)
  } finally {
    await Promise.all([
      observer.end(),
      producer.close(),
      first.close(),
      second.close()
    ])
  }
})

test('ReviewRunStore claims an expired preparation from its durable connector input', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-claimable-preparation-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      preparation_input_version: 'v1',
      preparation_input: { kind: 'connector_issue_review', issue_number: 12 }
    })
    assert.ok(admission.preparation_token)
    await store.preparations.checkpointInput(
      runId,
      admission.preparation_token,
      {
        kind: 'connector_issue_review',
        issue_number: 12,
        resolved: true
      }
    )
    assert.strictEqual((await store.preparations.expireStale()).concluded, 1)

    const claimed = await store.preparations.claimNext()
    assert.ok(claimed)
    const token = claimed.claim_token
    assert.deepStrictEqual(claimed, {
      run_id: runId,
      workflow: 'issue-review',
      input_version: 'v1',
      input: {
        kind: 'connector_issue_review',
        issue_number: 12,
        resolved: true
      },
      claim_token: token,
      attempt_count: 2
    })
    assert.notStrictEqual(token, admission.preparation_token)
    assert.strictEqual(
      await store.preparations.renewClaim(runId, admission.preparation_token),
      false
    )
    assert.strictEqual(await store.preparations.renewClaim(runId, token), false)
  } finally {
    await store.close()
  }
})

test('concurrent preparation consumers cannot own the same recovered work', async () => {
  // Preparation recovery is a connector work queue just like publication. Its
  // `FOR UPDATE ... SKIP LOCKED` claim must give one of two real connections the
  // recovered input and leave the other empty.
  const sharedConnector = `preparer:${randomUUID()}`
  const first = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const second = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  try {
    const admission = await first.admissions.create({
      workflow: 'issue-review',
      run_id: `run-concurrent-preparation-${randomUUID()}`,
      publish_context: {},
      preparation_input_version: 'v1',
      preparation_input: { kind: 'connector_issue_review' }
    })
    assert.ok(admission.preparation_token)
    assert.strictEqual((await first.preparations.expireStale()).concluded, 1)

    const claims = await Promise.all([
      first.preparations.claimNext(),
      second.preparations.claimNext()
    ])
    assert.strictEqual(claims.filter((claim) => claim !== null).length, 1)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('ReviewRunStore does not let ingress replay bypass preparation backoff', async () => {
  const store = await createStore()
  const runId = `run-preparation-backoff-${randomUUID()}`
  try {
    const admission = await store.admissions.admit({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: `delivery-${runId}`,
      preparation_input_version: 'v1',
      preparation_input: { kind: 'test' }
    })
    assert.ok(admission.preparation_token)
    assert.deepStrictEqual(
      await store.preparations.fail(
        runId,
        admission.preparation_token,
        { message: 'temporary' },
        { retry: true, retryAfterMs: 60_000 }
      ),
      { retry_scheduled: true }
    )
    const replay = await store.admissions.admit({
      workflow: 'issue-review',
      run_id: `other-${runId}`,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: `delivery-${runId}`,
      preparation_input_version: 'v1',
      preparation_input: { kind: 'test' }
    })
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.preparation_token, null)
    assert.strictEqual(await store.preparations.claimNext(), null)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews only the current preparation owner', async () => {
  const store = await createStore({ claimTimeoutMs: 1_000 })
  const runId = `run-renewed-preparation-${randomUUID()}`
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    assert.strictEqual(store.preparations.heartbeatIntervalMs(), 333)
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '100 milliseconds'
       WHERE run_id=$1`,
      [runId]
    )

    assert.strictEqual(
      await store.preparations.renewClaim(runId, admission.preparation_token),
      true
    )
    assert.strictEqual(
      await store.preparations.renewClaim(runId, randomUUID()),
      false
    )
    assert.strictEqual((await store.preparations.expireStale()).concluded, 0)

    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual(
      await store.preparations.renewClaim(runId, admission.preparation_token),
      false
    )
    assert.strictEqual((await store.preparations.expireStale()).concluded, 1)
  } finally {
    await observer.end()
    await store.close()
  }
})

test('ReviewRunStore keeps an admitted run queryable after preparation fails', async () => {
  const store = await createStore()
  const runId = `run-preparation-failed-${randomUUID()}`
  const ingressKey = `delivery-${randomUUID()}`
  try {
    const admission = await store.admissions.admit({
      workflow: 'pull-request-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    assert.ok(admission.preparation_token)

    // Input preparation happens after durable admission. Its failure must keep
    // the original run and ingress identity available for diagnosis/replay.
    await store.preparations.fail(runId, admission.preparation_token, {
      code: 'REVIEW_START_FAILED',
      message: 'input bundle upload failed'
    })

    const failed = await store.queries.getRun(runId)
    assert.strictEqual(failed?.execution.status, 'skipped')
    assert.strictEqual(failed?.ingress_kind, 'github_webhook')
    assert.strictEqual(failed?.ingress_key, ingressKey)
    assert.strictEqual(failed?.failure_code, 'REVIEW_START_FAILED')
    assert.strictEqual(failed?.failure_message, 'input bundle upload failed')
    assert.deepStrictEqual((await store.queries.listActiveRuns()).runs, [])
    assert.strictEqual(await store.publicationClaims.claim(runId), null)

    const replay = await store.admissions.admit({
      workflow: 'pull-request-review',
      run_id: `run-replay-${randomUUID()}`,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.record.run_id, runId)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records one immutable schema version across concurrent initialization', async () => {
  const first = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: connectorId()
  })
  const second = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: connectorId()
  })
  try {
    await Promise.all([first.initialize(), second.initialize()])
    const observer = new Pool({ connectionString: requireTestDatabase() })
    const versions = (
      await observer.query<{ version: number; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_versions ORDER BY version'
      )
    ).rows
    await observer.end()
    assert.deepStrictEqual(
      versions.map((item) => [item.version, item.name]),
      [[1, 'initial_coordination_schema']]
    )
    for (const version of versions)
      assert.match(version.checksum, /^[a-f0-9]{64}$/)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('ReviewRunStore initialization does not steal another replica preparation', async () => {
  const sharedConnector = connectorId()
  const runId = `run-${randomUUID()}`
  const first = await createStore({ connectorId: sharedConnector })
  await first.admissions.create({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: {}
  })
  await first.close()

  const restarted = await createStore({ connectorId: sharedConnector })
  try {
    const record = await restarted.queries.getRun(runId)
    assert.strictEqual(record?.execution.status, 'pending')
    assert.strictEqual(record?.failure_code, null)
  } finally {
    await restarted.close()
  }
})

test('ReviewRunStore atomically deduplicates concurrent ingress across connections', async () => {
  const sharedConnector = connectorId()
  const first = await createStore({ connectorId: sharedConnector })
  const second = await createStore({ connectorId: sharedConnector })
  const ingress = {
    workflow: 'issue-review' as const,
    publish_context: {},
    ingress_kind: 'github_webhook' as const,
    ingress_key: `delivery-${randomUUID()}`
  }
  try {
    const admissions = await Promise.all([
      first.admissions.admit({ ...ingress, run_id: `run-${randomUUID()}` }),
      second.admissions.admit({ ...ingress, run_id: `run-${randomUUID()}` })
    ])
    assert.strictEqual(admissions.filter((item) => item.created).length, 1)
    assert.strictEqual(
      new Set(admissions.map((item) => item.record.run_id)).size,
      1
    )
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('admission does not mistake a duplicate run id for an ingress replay race', async () => {
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  try {
    await store.admissions.admit({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: `delivery-${randomUUID()}`
    })

    await assert.rejects(
      store.admissions.admit({
        workflow: 'issue-review',
        run_id: runId,
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: `delivery-${randomUUID()}`
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'review_runs_pkey'
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore leaves ingress replay read-only and lets the coordinator take over preparation', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const ownerB = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const ingress = {
    workflow: 'issue-review' as const,
    publish_context: {},
    ingress_kind: 'github_webhook' as const,
    ingress_key: `delivery-${randomUUID()}`
  }
  try {
    const first = await ownerA.admissions.admit({
      ...ingress,
      run_id: `run-${randomUUID()}`
    })
    const replay = await ownerB.admissions.admit({
      ...ingress,
      run_id: `run-${randomUUID()}`
    })
    assert.ok(first.preparation_token)
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.preparation_token, null)
    assert.strictEqual(replay.record.run_id, first.record.run_id)

    assert.strictEqual((await ownerB.preparations.expireStale()).concluded, 1)
    const takeover = await ownerB.preparations.claimNext()
    assert.ok(takeover)
    assert.strictEqual(takeover.run_id, first.record.run_id)
    assert.notStrictEqual(takeover.claim_token, first.preparation_token)

    await assert.rejects(
      ownerA.preparations.checkpointInput(
        first.record.run_id,
        first.preparation_token,
        { stale: true }
      ),
      /claim was lost before checkpointing input/
    )
    await assert.rejects(
      ownerA.submissionTransitions.savePreparedSubmission(
        first.record.run_id,
        first.preparation_token,
        {},
        {}
      ),
      /Preparation claim was lost/
    )
    await assert.rejects(
      ownerA.submissionTransitions.markQueued(
        first.record.run_id,
        first.preparation_token,
        {}
      ),
      /cannot transition/
    )
    assert.deepStrictEqual(
      await ownerA.preparations.fail(
        first.record.run_id,
        first.preparation_token,
        {
          message: 'late failure'
        }
      ),
      { retry_scheduled: false },
      'a stale owner must not turn a fenced no-op into an error'
    )
    await ownerB.submissionTransitions.markQueued(
      takeover.run_id,
      takeover.claim_token,
      {}
    )
    assert.strictEqual(
      (await ownerA.queries.getRun(first.record.run_id))?.execution.status,
      'queued'
    )
  } finally {
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore recovers an uncertain submission with a fenced claim', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.submissionTransitions.savePreparedSubmission(
      runId,
      admission.preparation_token,
      {},
      await publishedInput(
        store,
        runId,
        admission.preparation_token as string,
        { api_version: 'v1' }
      )
    )
    await store.preparations.fail(runId, admission.preparation_token, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: 'response lost'
    })
    const staleToken = await store.executions.claimSubmissionRecovery(runId)
    const currentToken = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notStrictEqual(staleToken, currentToken)
    assert.strictEqual(
      await store.submissionTransitions.completeSubmissionRecovery(
        runId,
        staleToken
      ),
      false
    )
    assert.strictEqual(
      await store.submissionTransitions.completeSubmissionRecovery(
        runId,
        currentToken
      ),
      true
    )
    const recovered = await store.queries.getRun(runId)
    assert.strictEqual(recovered?.execution.status, 'queued')
    // An accepted replay proves the Execution did take the submission, so the execution phase
    // began then. `uncertain` deliberately left `started_at` NULL (acceptance was unknown);
    // resolving it without filling the start would leave a `queued` run with no beginning,
    // which no other path can produce and which silently breaks phase timing.
    assert.ok(
      recovered?.execution.started_at,
      'an accepted replay records when execution began'
    )
    assert.strictEqual(recovered?.execution.finished_at, null)
    assert.strictEqual(
      (await store.queries.listActiveRuns()).runs.some(
        (entry) => entry.run_id === runId
      ),
      true
    )
  } finally {
    await store.close()
  }
})

test('a restarted coordinator replays persisted uncertain submission input', async () => {
  const sharedConnector = `recovery:${randomUUID()}`
  const runId = `run-restarted-recovery-${randomUUID()}`
  const input = { api_version: 'v1', replay: true }
  const owner = await createStore({ connectorId: sharedConnector })
  try {
    const admission = await owner.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await assert.rejects(
      submitPreparedRun(
        owner,
        {
          runId,
          preparationToken: admission.preparation_token,
          publishContext: {},
          input: await publishedInput(
            owner,
            runId,
            admission.preparation_token,
            input
          )
        },
        async () => {
          throw new ExecutionSubmissionUncertainError('response lost')
        }
      ),
      ExecutionSubmissionUncertainError
    )
    // An uncertain submission may have reached the Execution, so execution is `uncertain` (a
    // later recovery replays it) rather than skipped or failed.
    assert.strictEqual(
      (await owner.queries.getRun(runId))?.execution.status,
      'uncertain'
    )
  } finally {
    await owner.close()
  }

  const restarted = await createStore({ connectorId: sharedConnector })
  const submissions: Array<Record<string, unknown>> = []
  try {
    await coordinateReviewRunsOnce(restarted, {
      recoverSubmission: async (run) => {
        await recoverReviewRunSubmission(restarted, run, {
          async submit(request) {
            submissions.push(request)
          },
          classifyError: (error) => {
            throw error
          }
        })
      },
      async readExecutionStatuses() {
        return { runs: [], missing: [], byRunId: new Map() }
      },
      async observeActiveRun() {},
      onDroppedRunRow(dropped) {
        throw dropped.error
      },
      onBlockedPreparationExpiry(blocked) {
        throw new Error(`unexpected blocked expiry: ${blocked.reason}`)
      }
    })

    assert.deepStrictEqual(submissions, [
      { workflow: 'issue-review', run_id: runId, input }
    ])
    assert.strictEqual(
      (await restarted.queries.getRun(runId))?.execution.status,
      'queued'
    )
  } finally {
    await restarted.close()
  }
})

test('ReviewRunStore fences a stale publisher after another connection takes over', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const ownerB = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const runId = await createSuccessfulRun(ownerA)
  try {
    const staleToken = await ownerA.publicationClaims.claim(runId)
    const currentToken = await ownerB.publicationClaims.claim(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notStrictEqual(staleToken, currentToken)
    assert.strictEqual(
      await ownerA.publications.complete(runId, staleToken),
      false
    )
    assert.strictEqual(
      await ownerA.publications.fail(
        runId,
        staleToken,
        { message: 'late failure' },
        { retry: true }
      ),
      false
    )
    assert.strictEqual(
      await ownerB.publications.complete(runId, currentToken),
      true
    )
    const record = await ownerA.queries.getRun(runId)
    assert.strictEqual(record?.publication.status, 'published')
  } finally {
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore does not publish while a required step is incomplete', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, [
      'issue:summary-comment'
    ])
    const [step] = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(step?.attempt_count, 0)
    assert.strictEqual(await store.publications.complete(runId, token), false)
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'publishing'
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore spends retry budget only for the current publication owner', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    const claimed = await store.queries.getRun(runId)
    assert.strictEqual(claimed?.publication.status, 'publishing')
    const publicationStart = claimed?.publication.started_at
    assert.ok(publicationStart, 'the claim starts the publication phase')
    assert.strictEqual(claimed?.publication.finished_at, null)

    assert.strictEqual(
      await store.publications.fail(
        runId,
        token,
        { code: 'HTTP_503', message: 'unavailable' },
        { retry: true }
      ),
      true
    )
    const record = await store.queries.getRun(runId)
    assert.strictEqual(record?.execution.status, 'succeeded')
    // A retryable failure returns the row to pending, so the phase has not ended. `finished_at`
    // is the one timestamp that is cleared rather than only ever set: leaving it behind would
    // report a still-running publication as completed. The start, by contrast, must not move.
    assert.strictEqual(record?.publication.status, 'pending')
    assert.strictEqual(
      record?.publication.finished_at,
      null,
      'a retryable failure must not leave a phase end behind'
    )
    assert.strictEqual(
      record?.publication.started_at,
      publicationStart,
      'a retry keeps the original publication start'
    )
    assert.deepStrictEqual((await store.queries.listActiveRuns()).runs, [])
  } finally {
    await store.close()
  }
})

test('the publication axis records an event only when its derived status actually changes', async () => {
  // The axis status is derived from its steps. That derivation decides two things at once: the
  // value written, and whether the write is a transition worth auditing. When those were two
  // copies of the same expression, editing one could make the row move without an event (a
  // silent timeline gap) or emit an event for a state no write produced. This pins the pair the
  // derivation must keep equal: a settlement that leaves the axis where it was writes nothing,
  // and one that moves it writes exactly one event naming the status the row now holds.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, [
      'issue:summary-comment',
      'issue:draft-pr'
    ])
    await store.publications.requirePublicationStepClaim(
      runId,
      token,
      'issue:summary-comment'
    )

    const publicationEvents = async () =>
      (await store.queries.listEvents(runId)).filter(
        (event) => event.axis === 'publication'
      )

    // A retryable failure leaves the axis publishing: the step is still claimable, so the axis
    // has nothing new to report and must not write an event.
    const beforeRetry = (await publicationEvents()).length
    await store.publications.failPublicationStep(
      runId,
      token,
      'issue:summary-comment',
      { message: 'retryable' },
      { retry: true }
    )
    assert.strictEqual(
      (await publicationEvents()).length,
      beforeRetry,
      'an unchanged derived status must not be audited as a transition'
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'publishing'
    )

    // A terminal step failure fails the axis. Its event must name the state the row actually
    // left, which is the derived status, not a hardcoded guess. The step write is fenced on the
    // owner's claim, so the retried step is claimed again first, exactly as the publish path
    // does between attempts.
    await store.publications.requirePublicationStepClaim(
      runId,
      token,
      'issue:summary-comment'
    )
    await store.publications.failPublicationStep(
      runId,
      token,
      'issue:summary-comment',
      { code: 'GITHUB_REJECTED', message: 'rejected' },
      { retry: false }
    )
    const last = (await publicationEvents()).at(-1)
    assert.strictEqual(last?.to_status, 'failed')
    assert.strictEqual(
      last?.from_status,
      (await store.queries.getRun(runId))?.publication.status === 'failed'
        ? 'publishing'
        : last?.from_status
    )
  } finally {
    await store.close()
  }
})

test('a publication left uncertain by a dead publisher is reclaimed once its lease expires', async () => {
  // The axis reads `uncertain` while its owner reconciles a step. Before this, no claim
  // predicate accepted that row: `publishing` with an expired lease was reclaimable, `uncertain`
  // was not, so a run whose reconciling publisher died was unreachable for automated work and
  // only an operator resume could move it. A live lease must still be respected, which is why
  // the same claim-timeout fence applies to both states.
  // Two stores share one connector id because publication claims are scoped by connector, not
  // by process: the reclaim has to come from outside the owning store, or the test would only
  // prove that a store can reclaim its own row.
  const ownerConnector = `publication-reclaim:${randomUUID()}`
  const store = await createStore({ connectorId: ownerConnector })
  const runId = await createSuccessfulRun(store)
  const sibling = await createStore({ connectorId: ownerConnector })
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, [
      'issue:summary-comment'
    ])
    // Drive the step to `uncertain` the way the publish path does: report an unanswered attempt,
    // then ask for the next one, until the step has no attempt left. That final refused request
    // is what parks the step.
    let stepParked = false
    for (let attempt = 0; attempt < 10 && !stepParked; attempt += 1) {
      // Only a claimable step is claimed again: once it is `uncertain` the claim is refused with
      // `not_claimable` (its outcome is being established, not retried), which is not the
      // exhaustion the loop is looking for.
      const status = (await store.publications.listPublicationSteps(runId))[0]
        ?.status
      if (status === 'pending' || status === 'failed') {
        await store.publications.requirePublicationStepClaim(
          runId,
          token,
          'issue:summary-comment'
        )
      }
      await store.publications.failPublicationStep(
        runId,
        token,
        'issue:summary-comment',
        { message: 'response lost' },
        { retry: true }
      )
      stepParked = await store.publications
        .requirePublicationStepClaim(runId, token, 'issue:summary-comment')
        .then(
          () => false,
          () => true
        )
    }
    assert.ok(stepParked, 'the step must run out of attempts')
    assert.strictEqual(
      (await store.publications.listPublicationSteps(runId))[0]?.status,
      'uncertain'
    )
    // The axis reports its strongest step, and the owner is alive, so it is `uncertain` too.
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'uncertain'
    )

    // A live lease is not stolen, by either claim path.
    assert.strictEqual(await sibling.publicationClaims.claim(runId), null)
    assert.strictEqual(await sibling.publicationClaims.claimNext(0), null)

    // The owner died. Its lease is moved past the default claim timeout (ten minutes), so the
    // only thing that can admit the reclaim is the fence being expired.
    const clock = new Pool({ connectionString: requireTestDatabase() })
    try {
      await clock.query(
        `UPDATE publications SET claimed_at=clock_timestamp()-interval '1 hour'
         WHERE run_id=$1`,
        [runId]
      )
      const expired = await clock.query<{ expired: boolean }>(
        `SELECT claimed_at <= clock_timestamp()-($2*interval '1 millisecond') AS expired
         FROM publications WHERE run_id=$1`,
        [runId, 10 * 60 * 1000]
      )
      assert.strictEqual(expired.rows[0]?.expired, true)
    } finally {
      await clock.end()
    }

    const reclaimed = await sibling.publicationClaims.claim(runId)
    assert.ok(reclaimed, 'an expired uncertain lease must be reclaimable')
    assert.notStrictEqual(reclaimed, token)
    const event = (await store.queries.listEvents(runId))
      .filter((item) => item.axis === 'publication')
      .at(-1)
    assert.strictEqual(event?.from_status, 'uncertain')
    assert.strictEqual(event?.to_status, 'publishing')
    assert.strictEqual(event?.reason_code, 'PUBLICATION_LEASE_EXPIRED')
  } finally {
    await sibling.close()
    await store.close()
  }
})

test('ReviewRunStore fences publication step commits with the current publication token', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = await createSuccessfulRun(store)
  try {
    const staleToken = await store.publicationClaims.claim(runId)
    assert.ok(staleToken)
    await store.publications.initializePublicationSteps(runId, staleToken, [
      'repository:summary-issue'
    ])
    await store.publications.requirePublicationStepClaim(
      runId,
      staleToken,
      'repository:summary-issue'
    )

    const currentToken = await store.publicationClaims.claim(runId)
    assert.ok(currentToken)
    assert.strictEqual(
      await store.publications.completePublicationStep(
        runId,
        staleToken,
        'repository:summary-issue',
        {
          id: '7'
        }
      ),
      false
    )
    assert.strictEqual(
      await store.publications.failPublicationStep(
        runId,
        staleToken,
        'repository:summary-issue',
        {
          message: 'late failure'
        }
      ),
      false
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports an exhausted publication step as deterministic', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await store.publicationClaims.claim(runId)
      assert.ok(token)
      if (attempt === 0)
        await store.publications.initializePublicationSteps(runId, token, [
          'issue:summary-comment'
        ])
      await store.publications.requirePublicationStepClaim(
        runId,
        token,
        'issue:summary-comment'
      )
      assert.strictEqual(
        await store.publications.failPublicationStep(
          runId,
          token,
          'issue:summary-comment',
          {
            message: 'temporary failure'
          }
        ),
        true
      )
      assert.strictEqual(
        (await store.publications.listPublicationSteps(runId))[0]
          ?.attempt_count,
        attempt + 1
      )
      assert.strictEqual(
        await store.publications.fail(
          runId,
          token,
          { message: 'temporary failure' },
          { retry: true }
        ),
        true
      )
    }

    const finalToken = await store.publicationClaims.claim(runId)
    assert.ok(finalToken)
    await assert.rejects(
      store.publications.requirePublicationStepClaim(
        runId,
        finalToken,
        'issue:summary-comment'
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_RETRY_EXHAUSTED'
    )
    // Exhaustion alone does NOT conclude the step. The last attempt may have taken effect
    // remotely before its response was lost, and Review Runs cannot see GitHub, so the step is
    // left for the connector to reconcile.
    const [exhaustedStep] = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(exhaustedStep?.status, 'uncertain')
    assert.strictEqual(exhaustedStep?.attempt_count, 3)

    // A reconciliation that confirms nothing was published is what makes it terminal.
    assert.strictEqual(
      await store.publications.settleExhaustedPublicationStep(
        runId,
        finalToken,
        'issue:summary-comment',
        { found: false }
      ),
      true
    )
    const [step] = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(step?.status, 'terminal_failed')
    assert.strictEqual(step?.attempt_count, 3)
  } finally {
    await store.close()
  }
})

test('a reconciliation that finds the side effect completes an exhausted step', async () => {
  // The failure this prevents: a publisher posted the comment and died before recording it. The
  // step spends its budget, and reporting it as failed would tell the requester nothing was
  // published while the comment is on GitHub. Finding it turns the step into a success instead.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await store.publicationClaims.claim(runId)
      assert.ok(token)
      if (attempt === 0)
        await store.publications.initializePublicationSteps(runId, token, [
          'issue:summary-comment'
        ])
      await store.publications.requirePublicationStepClaim(
        runId,
        token,
        'issue:summary-comment'
      )
      await store.publications.failPublicationStep(
        runId,
        token,
        'issue:summary-comment',
        {
          message: 'response lost after posting'
        }
      )
      await store.publications.fail(
        runId,
        token,
        { message: 'response lost after posting' },
        { retry: true }
      )
    }

    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await assert.rejects(
      store.publications.requirePublicationStepClaim(
        runId,
        token,
        'issue:summary-comment'
      )
    )
    assert.strictEqual(
      await store.publications.settleExhaustedPublicationStep(
        runId,
        token,
        'issue:summary-comment',
        {
          found: true,
          remote: {
            id: '4242',
            url: 'https://github.com/octo/example/issues/1#c'
          }
        }
      ),
      true
    )
    const [step] = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(step?.status, 'succeeded')
    assert.strictEqual(step?.remote_object_id, '4242')
    // The publication can now finish: the run is not failed for work that was done.
    assert.strictEqual(await store.publications.complete(runId, token), true)
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'published'
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records execution failure without publication failure', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    assert.strictEqual(
      await store.failExecution(runId, {
        code: 'EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const record = await store.queries.getRun(runId)
    assert.strictEqual(record?.execution.status, 'failed')
    assert.strictEqual(record?.failure_code, 'EXECUTION_FAILED')
    assert.strictEqual(await store.publicationClaims.claim(runId), null)

    // An execution failure ends the run, so the requester has to be told. The notice names the
    // axis that failed, because the reply says the review started but could not finish rather
    // than claiming it never started.
    const notice = await store.notices.claimNext()
    assert.notStrictEqual(notice, null)
    assert.strictEqual(notice?.run_id, runId)
    assert.strictEqual(notice?.axis, 'execution')
    assert.strictEqual(notice?.reason_code, 'EXECUTION_FAILED')
    assert.strictEqual(
      await store.notices.complete(
        notice?.notice_id ?? '',
        notice?.claim_token ?? '',
        true,
        'https://github.com/example/example/issues/1#issuecomment-1'
      ),
      true
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore stores the comment a delivered notice points at', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  const commentUrl =
    'https://github.com/example/example/issues/1#issuecomment-99'
  try {
    assert.strictEqual(
      await store.failExecution(runId, {
        code: 'EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const notice = await store.notices.claimNext()
    assert.ok(notice)

    // A delivery has to name where the requester can read it. Storing `delivered` with no URL
    // would claim someone was told while giving no way to check.
    await assert.rejects(
      store.notices.complete(notice.notice_id, notice.claim_token, true),
      /cannot be delivered without a comment_url/
    )

    assert.strictEqual(
      await store.notices.complete(
        notice.notice_id,
        notice.claim_token,
        true,
        commentUrl
      ),
      true
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.notices?.[0]?.comment_url,
      commentUrl
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records an undeliverable notice as failed, not skipped', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = await createQueuedRun(store)
  try {
    assert.strictEqual(
      await store.failExecution(runId, {
        code: 'EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const notice = await store.notices.claimNext()
    assert.ok(notice)
    // The connector could not reach the provider. That is a failed delivery, not a decision to
    // skip one, and the two must not share a state: an operator reading `skipped` would think
    // nothing was attempted.
    assert.strictEqual(
      await store.notices.complete(notice.notice_id, notice.claim_token, false),
      true
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.notices?.[0]?.status,
      'failed'
    )
    // The notice stays terminal: nothing retries it, by design. Reaching the provider is an
    // operator problem, not one this loop can solve by trying again.
    assert.strictEqual(await store.notices.claimNext(), null)
  } finally {
    await store.close()
  }
})

test('every terminal path that concludes a run queues a failure notice', async () => {
  // The edges test proves the recorded transitions are declared; it cannot prove a terminal
  // path also told the requester. This pins the other half: whichever way a run ends, a notice
  // exists, and it names the axis that failed. Without it, a conclusion path could silently
  // leave the requester uninformed, which is how the publication coordinator's terminal path
  // and the unconfirmed-replay path both went unnoticed.
  const store = await createStore()

  const noticeFor = async (runId: string): Promise<string | null> => {
    const run = await store.queries.getRun(runId)
    assert.strictEqual(
      run?.notices?.[0]?.status,
      'pending',
      `${runId} ended without queueing a notice`
    )
    return run?.notices?.[0]?.axis ?? null
  }

  try {
    // preparation failure
    const preparationRun = `run-${randomUUID()}`
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: preparationRun,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.preparations.fail(
      preparationRun,
      admission.preparation_token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' },
      { retry: false }
    )
    assert.strictEqual(await noticeFor(preparationRun), 'preparation')

    // execution failure
    const executionRun = await createQueuedRun(store)
    assert.strictEqual(
      await store.failExecution(executionRun, {
        code: 'EXECUTION_FAILED',
        message: 'boom'
      }),
      true
    )
    assert.strictEqual(await noticeFor(executionRun), 'execution')

    // publication failure concluded by the coordinator, not by a terminal step
    const publicationRun = await createSuccessfulRun(store)
    const publicationToken = await store.publicationClaims.claim(publicationRun)
    assert.ok(publicationToken)
    await store.publications.initializePublicationSteps(
      publicationRun,
      publicationToken,
      ['issue:summary-comment']
    )
    assert.strictEqual(
      await store.publications.fail(
        publicationRun,
        publicationToken,
        { code: 'PUBLICATION_STEPS_INCOMPLETE', message: 'steps missing' },
        { retry: false }
      ),
      true
    )
    assert.strictEqual(await noticeFor(publicationRun), 'publication')

    // an operator's decision to abandon a blocked run
    const blockedRun = `run-${randomUUID()}`
    const blockedAdmission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: blockedRun,
      publish_context: {}
    })
    assert.ok(blockedAdmission.preparation_token)
    const observer = new Pool({ connectionString: requireTestDatabase() })
    try {
      await observer.query(
        `UPDATE preparations SET attempt_count=8,
           claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
        [blockedRun]
      )
      await observer.query(
        `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
           finished_at=clock_timestamp(), workflow_result='{}'::jsonb WHERE run_id=$1`,
        [blockedRun]
      )
    } finally {
      await observer.end()
    }
    const expiry = await store.preparations.expireStale()
    assert.strictEqual(expiry.blocked.length, 1)
    // Disconnecting is a conclusion about automation, not about the run: it asks a person to
    // look, so it queues an attention notice rather than reporting a failure.
    const disconnectedNotice = (await store.queries.getRun(blockedRun))?.notices
    assert.deepStrictEqual(
      disconnectedNotice?.map((notice) => [notice.kind, notice.axis]),
      [['attention', 'preparation']],
      'disconnecting queues an attention notice, never a failure report'
    )
    await store.operatorDecisions.abandonBlockedPreparation(
      blockedRun,
      'operator decision'
    )
    assert.strictEqual(await noticeFor(blockedRun), 'preparation')
    // The execution this run had already advanced is concluded with it. Leaving it `running`
    // let a later observation record `succeeded` with publication `skipped`, an outcome that
    // looks normal while the notice says the run failed.
    const concluded = await store.queries.getRun(blockedRun)
    assert.strictEqual(concluded?.execution.status, 'succeeded')
    assert.strictEqual(concluded?.publication.status, 'skipped')
  } finally {
    await store.close()
  }
})

test('abandoning a blocked run concludes an execution that is still in flight', async () => {
  // A blocked run is blocked because execution already advanced, which includes `running`. That
  // execution cannot deliver anything once the run is abandoned, and leaving it live let a later
  // observation record `succeeded` beside a `skipped` publication - an outcome that reads as a
  // normal one while the failure notice says the run ended. It is failed here instead; an
  // execution that already succeeded is a real result and is left alone.
  const store = await createStore({ claimTimeoutMs: 1 })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    for (const status of ['running', 'succeeded'] as const) {
      const runId = `run-${randomUUID()}`
      await store.admissions.create({
        workflow: 'issue-review',
        run_id: runId,
        publish_context: {}
      })
      await observer.query(
        `UPDATE preparations SET status='preparing', claim_token=$2,
           claimed_at=clock_timestamp()-interval '1 hour', attempt_count=8,
           started_at=clock_timestamp(), finished_at=NULL WHERE run_id=$1`,
        [runId, randomUUID()]
      )
      await observer.query(
        `UPDATE executions SET status=$2, started_at=clock_timestamp(),
           finished_at=CASE WHEN $2='succeeded' THEN clock_timestamp() END,
           workflow_result=CASE WHEN $2='succeeded' THEN '{}'::jsonb END
         WHERE run_id=$1`,
        [runId, status]
      )
      assert.strictEqual(
        (await store.preparations.expireStale()).blocked.length,
        1
      )
      const abandoned = await store.operatorDecisions.abandonBlockedPreparation(
        runId,
        'operator'
      )
      assert.strictEqual(
        abandoned.execution.status,
        status === 'running' ? 'failed' : 'succeeded',
        `an execution that was ${status} is ${
          status === 'running' ? 'failed' : 'left as the real result'
        }`
      )
      assert.strictEqual(abandoned.publication.status, 'skipped')
      // Nothing can move it afterwards, whichever way it was concluded.
      assert.strictEqual(
        await store.executions.recordExecutionSuccess(
          runId,
          { run_id: runId },
          { status: 'unavailable' }
        ),
        false
      )
    }
  } finally {
    await observer.end()
    await store.close()
  }
})

test('ReviewRunStore announces only a publication failure that ends the run', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, [
      'issue:summary-comment'
    ])
    await store.publications.requirePublicationStepClaim(
      runId,
      token,
      'issue:summary-comment'
    )
    // A step that will be retried is not yet news for the requester: announcing it would post a
    // reply per attempt for a run that may still succeed.
    assert.strictEqual(
      await store.publications.failPublicationStep(
        runId,
        token,
        'issue:summary-comment',
        { code: 'GITHUB_RATE_LIMITED', message: 'slow down' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual(
      await store.publications.fail(
        runId,
        token,
        { message: 'slow down' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual(
      await store.notices.claimNext(),
      null,
      'a retryable step failure must not produce a notice'
    )

    // The same step failing for a reason that cannot be retried ends the run, so it does.
    const terminalToken = await store.publicationClaims.claim(runId)
    assert.ok(terminalToken)
    await store.publications.requirePublicationStepClaim(
      runId,
      terminalToken,
      'issue:summary-comment'
    )
    assert.strictEqual(
      await store.publications.failPublicationStep(
        runId,
        terminalToken,
        'issue:summary-comment',
        { code: 'GITHUB_VALIDATION_REJECTED', message: 'rejected' },
        { retry: false }
      ),
      true
    )
    const notice = await store.notices.claimNext()
    assert.strictEqual(notice?.run_id, runId)
    assert.strictEqual(notice?.axis, 'publication')
    assert.strictEqual(notice?.reason_code, 'GITHUB_VALIDATION_REJECTED')
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews a publication claim before another owner can take it', async () => {
  const sharedConnector = connectorId()
  const ownerA = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 1_000
  })
  const ownerB = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 1_000
  })
  const runId = await createSuccessfulRun(ownerA)
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    const token = await ownerA.publicationClaims.claim(runId)
    assert.ok(token)
    await observer.query(
      "UPDATE publications SET claimed_at=clock_timestamp()-interval '2 seconds' WHERE run_id=$1 AND connector_id=$2",
      [runId, sharedConnector]
    )
    assert.strictEqual(await ownerA.publications.renewClaim(runId, token), true)
    assert.strictEqual(await ownerB.publicationClaims.claim(runId), null)
  } finally {
    await observer.end()
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore accepts an identical publication step set under a case-insensitive collation', async () => {
  // Regression guard for the #96 wedge. Persisted step keys come back in the
  // database collation order (`en_US.utf8` orders `case-7` before
  // `CVE-2024-1008`, while JavaScript sorts by UTF-16 code unit). Comparing the
  // two raw orders made the second call with an identical key set throw
  // 'Publication step set changed', and the publication could never leave
  // 'pending'.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  const stepKeys = [
    'repository:delivery:CVE-2024-1008',
    'repository:delivery:case-7',
    'repository:summary-issue'
  ]
  try {
    const firstToken = await store.publicationClaims.claim(runId)
    assert.ok(firstToken)
    await store.publications.initializePublicationSteps(
      runId,
      firstToken,
      stepKeys
    )
    assert.strictEqual(
      await store.publications.fail(
        runId,
        firstToken,
        { message: 'temporary failure' },
        { retry: true }
      ),
      true
    )

    const secondToken = await store.publicationClaims.claim(runId)
    assert.ok(secondToken)
    await store.publications.initializePublicationSteps(
      runId,
      secondToken,
      stepKeys
    )

    const persisted = (
      await store.publications.listPublicationSteps(runId)
    ).map((step) => step.step_key)
    assert.deepStrictEqual(persisted.sort(), [...stepKeys].sort())
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports a duplicate publication step set as deterministic', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await assert.rejects(
      store.publications.initializePublicationSteps(runId, token, [
        'repository:summary-issue',
        'repository:summary-issue'
      ]),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_SET_DUPLICATE'
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports a changed publication step set as deterministic', async () => {
  // A stored run's step set is fixed, so a genuine change can never be repaired
  // by re-claiming the publication; it must reach a terminal state instead.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const firstToken = await store.publicationClaims.claim(runId)
    assert.ok(firstToken)
    await store.publications.initializePublicationSteps(runId, firstToken, [
      'repository:summary-issue'
    ])
    assert.strictEqual(
      await store.publications.fail(
        runId,
        firstToken,
        { message: 'temporary failure' },
        { retry: true }
      ),
      true
    )

    const secondToken = await store.publicationClaims.claim(runId)
    assert.ok(secondToken)
    await assert.rejects(
      store.publications.initializePublicationSteps(runId, secondToken, [
        'repository:summary-issue',
        'repository:summary-comment'
      ]),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_SET_CHANGED'
    )
  } finally {
    await store.close()
  }
})

test('claimNextPublication returns the persisted result, context, and artifact', async () => {
  // `claimNextPublication` hands the publisher everything it needs to publish: the Execution's
  // opaque result, the publish context, and the artifact reference, alongside the claim
  // token. `claimPublication` (covered above) only returns a token, so this is the shape a
  // publisher actually receives and must match what was persisted.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const context = { repository: 'octo/example' }
  const admission = await store.admissions.create({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.submissionTransitions.markQueued(
    runId,
    admission.preparation_token,
    context
  )
  const workflowResult = {
    run_id: runId,
    review_record: { analysis: { verdict: 'no-findings' } }
  }
  assert.strictEqual(
    await store.executions.recordExecutionSuccess(runId, workflowResult, {
      status: 'unavailable'
    }),
    true
  )
  try {
    const work = await store.publicationClaims.claimNext()
    assert.strictEqual(work?.run_id, runId)
    assert.strictEqual(work?.claim_token.length, 36)
    assert.deepStrictEqual(work?.artifact_storage, { status: 'unavailable' })
    assert.deepStrictEqual(work?.workflow_result, workflowResult)
    assert.deepStrictEqual(work?.publish_context, context)
  } finally {
    await store.close()
  }
})

test('a restarted publisher can claim persisted publication work', async () => {
  const sharedConnector = `publisher-restart:${randomUUID()}`
  const runId = `run-restarted-publication-${randomUUID()}`
  const first = await createStore({ connectorId: sharedConnector })
  try {
    await createSuccessfulRun(first, runId)
  } finally {
    await first.close()
  }

  const restarted = await createStore({ connectorId: sharedConnector })
  try {
    const work = await restarted.publicationClaims.claimNext()
    assert.strictEqual(work?.run_id, runId)
    assert.ok(work?.claim_token)
  } finally {
    await restarted.close()
  }
})

test('concurrent claimNextPublication consumers cannot own the same ready run', async () => {
  // Two publishers polling the same connector must not both claim the ready run: the claim is
  // `FOR UPDATE ... SKIP LOCKED`, so one wins and the other finds nothing. Asserting this with
  // real concurrent connections (rather than sequential calls) is what exercises the lock.
  const connectorId = `publisher:${randomUUID()}`
  const first = await createStore({ connectorId })
  const second = await createStore({ connectorId })
  try {
    await createSuccessfulRun(first)
    const claims = await Promise.all([
      first.publicationClaims.claimNext(),
      second.publicationClaims.claimNext()
    ])
    assert.strictEqual(claims.filter((claim) => claim !== null).length, 1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('claimNextPublication does not treat an execution that left succeeded as publishable', async () => {
  // The claim's UPDATE re-states the full publishable predicate (execution succeeded with a
  // result), not only the publication status. This pins the observable consequence: a run whose
  // execution axis is no longer successful is never selected as publishable work, and its
  // publication stays untouched.
  const connectorId = `publisher:${randomUUID()}`
  const store = await createStore({ connectorId })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  const runId = await createSuccessfulRun(store, `run-${randomUUID()}`)
  try {
    await observer.query(
      `UPDATE executions SET status='failed' WHERE run_id=$1 AND connector_id=$2`,
      [runId, connectorId]
    )
    assert.strictEqual(
      await store.publicationClaims.claimNext(),
      null,
      'an execution that is not succeeded is not publishable'
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'pending'
    )
  } finally {
    await observer.end()
    await store.close()
  }
})

test('a retryable publication failure makes the run claimable again', async () => {
  // The counterpart to `spends retry budget only for the current publication owner`, which
  // asserts the retryable failure is accepted: this asserts the run becomes claimable again
  // afterwards, so the retry the budget allowed actually happens.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const work = await store.publicationClaims.claimNext()
    assert.ok(work)
    assert.strictEqual(
      await store.publications.fail(
        runId,
        work.claim_token,
        { message: 'GitHub unavailable' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual(
      (await store.publicationClaims.claimNext())?.run_id,
      runId
    )
  } finally {
    await store.close()
  }
})

test('the write path refuses an artifact storage value the contract forbids', async () => {
  // Every `artifact_storage` write narrows the value through `normalizeArtifactStorage`, so a
  // shape the contract cannot represent (an `available` record without its artifact) is
  // rejected before it is persisted rather than being discovered later by a read. The run id
  // is in the message, so the fault names the record.
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    await assert.rejects(
      store.executions.recordArtifactStorage(runId, { status: 'available' }),
      new RegExp(
        `run ${runId} is an available artifact storage record without its artifact`
      )
    )
    await assert.rejects(
      store.executions.recordExecutionSuccess(
        runId,
        { run_id: runId },
        { status: 'available' }
      ),
      /without its artifact reference/
    )
    await assert.rejects(
      store.failExecution(
        runId,
        { message: 'failed' },
        { status: 'available' }
      ),
      /without its artifact reference/
    )
    // Nothing was written: the run is still exactly as it was queued.
    assert.strictEqual(
      (await store.queries.getRun(runId))?.artifact_storage,
      null
    )
  } finally {
    await store.close()
  }
})

test('every publication transition writes exactly one audit event', async () => {
  // The audit log is the operator's timeline of a run. A publication state change that is
  // not logged makes the History view claim the publication never started (or never got
  // skipped), so each write path below must leave one matching publication event.
  const store = await createStore()
  const publicationEvents = async (runId: string) =>
    (await store.queries.listEvents(runId))
      .filter((event) => event.axis === 'publication')
      .map((event) => `${event.from_status}->${event.to_status}`)
  try {
    // Terminal execution failure skips publication.
    const failedRun = await createQueuedRun(store)
    assert.strictEqual(
      await store.failExecution(failedRun, {
        code: 'EXECUTION_FAILED',
        message: 'boom'
      }),
      true
    )
    assert.deepStrictEqual(await publicationEvents(failedRun), [
      'null->pending',
      'pending->skipped'
    ])

    // Claiming publishable work starts publishing.
    const claimedRun = await createSuccessfulRun(store)
    assert.ok(await store.publicationClaims.claim(claimedRun))
    assert.deepStrictEqual(await publicationEvents(claimedRun), [
      'null->pending',
      'pending->publishing'
    ])

    // An uncertain submission may still be accepted, so publication must NOT be ruled out yet:
    // it stays `pending` until execution is conclusively skipped or failed.
    const recoveredRun = `run-${randomUUID()}`
    const admitted = await store.admissions.create({
      workflow: 'issue-review',
      run_id: recoveredRun,
      publish_context: {}
    })
    assert.ok(admitted.preparation_token)
    await store.preparations.fail(
      recoveredRun,
      admitted.preparation_token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    assert.strictEqual(
      (await store.queries.getRun(recoveredRun))?.publication.status,
      'pending',
      'an uncertain submission must not skip publication'
    )
    const recoveryToken =
      await store.executions.claimSubmissionRecovery(recoveredRun)
    assert.ok(recoveryToken)
    assert.strictEqual(
      await store.submissionTransitions.completeSubmissionRecovery(
        recoveredRun,
        recoveryToken
      ),
      true
    )
    assert.deepStrictEqual(await publicationEvents(recoveredRun), [
      'null->pending'
    ])

    // Only a rejected replay proves there is nothing to publish.
    const rejectedRun = `run-${randomUUID()}`
    const rejectedAdmission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: rejectedRun,
      publish_context: {}
    })
    assert.ok(rejectedAdmission.preparation_token)
    await store.preparations.fail(
      rejectedRun,
      rejectedAdmission.preparation_token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    const rejectedToken =
      await store.executions.claimSubmissionRecovery(rejectedRun)
    assert.ok(rejectedToken)
    assert.strictEqual(
      await store.submissionTransitions.failSubmissionRecovery(
        rejectedRun,
        rejectedToken,
        {
          code: 'SUBMISSION_FAILED',
          message: 'no'
        }
      ),
      true
    )
    assert.deepStrictEqual(await publicationEvents(rejectedRun), [
      'null->pending',
      'pending->skipped'
    ])
  } finally {
    await store.close()
  }
})

test('each lifecycle axis records an immutable start and end', async () => {
  // The three axes used to borrow times: preparation had no end (its `updated_at` also moved on
  // heartbeats and input checkpoints), execution had no explicit end (its `observed_at` happened
  // to freeze), and publication had no start at all (the console borrowed the execution end).
  // Every phase is now timed by two fields that are written once, so this test pins the one
  // property that makes them usable: they never move after being set.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)

    // Admitted but not claimed again: the preparation claim taken at admission started the
    // phase, and nothing has ended yet.
    const admitted = await store.queries.getRun(runId)
    assert.ok(admitted?.preparation?.started_at, 'admission starts preparation')
    assert.strictEqual(admitted?.preparation?.finished_at, null)
    assert.strictEqual(
      admitted?.execution.started_at,
      null,
      'execution has not begun'
    )
    assert.strictEqual(admitted?.execution.finished_at, null)
    assert.strictEqual(admitted?.publication.started_at, null)

    // Preparation ends when the input is handed over; execution starts at the same moment.
    await store.submissionTransitions.markQueued(
      runId,
      admission.preparation_token,
      {}
    )
    const queued = await store.queries.getRun(runId)
    assert.strictEqual(queued?.preparation?.status, 'submitted')
    assert.ok(queued?.preparation?.finished_at, 'submission ends preparation')
    assert.ok(queued?.execution.started_at, 'submission starts execution')
    assert.strictEqual(
      queued?.execution.finished_at,
      null,
      'execution still in flight'
    )
    const preparationStart = queued?.preparation?.started_at
    const preparationEnd = queued?.preparation?.finished_at
    assert.ok(
      Date.parse(preparationEnd!) >= Date.parse(preparationStart!),
      'preparation end is not before its start'
    )

    // Execution ends on the terminal result; publication has not started, so it has no start.
    assert.strictEqual(
      await store.executions.recordExecutionSuccess(
        runId,
        { run_id: runId },
        { status: 'unavailable' }
      ),
      true
    )
    const succeeded = await store.queries.getRun(runId)
    assert.ok(succeeded?.execution.finished_at, 'success ends execution')
    assert.strictEqual(succeeded?.publication.started_at, null)
    // `observed_at` and `finished_at` are written in the same UPDATE, so the end of the phase
    // and the last observation agree at this instant.
    assert.strictEqual(
      succeeded?.execution.finished_at,
      succeeded?.execution.updated_at
    )

    // Publication starts on the first claim, and a retryable failure that re-pends the row and
    // claims it again must not move the start.
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    const publishing = await store.queries.getRun(runId)
    assert.strictEqual(publishing?.publication.status, 'publishing')
    const publicationStart = publishing?.publication.started_at
    assert.ok(publicationStart, 'first claim starts publication')

    await store.publications.initializePublicationSteps(runId, token, [
      'repository:comment'
    ])
    assert.strictEqual(
      await store.publications.fail(
        runId,
        token,
        { code: 'GITHUB_RATE_LIMITED', message: 'slow down' },
        { retry: true }
      ),
      true
    )
    const retried = await store.queries.getRun(runId)
    assert.strictEqual(retried?.publication.status, 'pending')
    assert.strictEqual(
      retried?.publication.started_at,
      publicationStart,
      'a retryable failure keeps the original publication start'
    )

    const secondToken = await store.publicationClaims.claim(runId)
    assert.ok(secondToken)
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.started_at,
      publicationStart,
      're-claiming keeps the original publication start'
    )

    // The end of each phase is stable across later writes.
    const before = await store.queries.getRun(runId)
    await store.executions.touchObservation(runId)
    await store.executions.recordArtifactStorage(runId, {
      status: 'unavailable'
    })
    const after = await store.queries.getRun(runId)
    assert.strictEqual(
      after?.execution.finished_at,
      before?.execution.finished_at
    )
    assert.strictEqual(
      after?.preparation?.finished_at,
      before?.preparation?.finished_at
    )
    assert.strictEqual(
      after?.publication.started_at,
      before?.publication.started_at
    )
  } finally {
    await store.close()
  }
})

test('a preparation retry does not move the phase start', async () => {
  // `started_at` answers "when did this phase begin", not "when was it last claimed". A retry
  // returns the row to pending and it is claimed again; moving the start there would silently
  // shrink every retried preparation's measured duration.
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    const started = (await store.queries.getRun(runId))?.preparation?.started_at
    assert.ok(started)

    // A retryable failure returns the row to pending for another attempt.
    const result = await store.preparations.fail(
      runId,
      admission.preparation_token,
      { code: 'PREPARATION_TRANSIENT', message: 'try again' },
      { retry: true, retryAfterMs: 0 }
    )
    assert.deepStrictEqual(result, { retry_scheduled: true })
    assert.strictEqual(
      (await store.queries.getRun(runId))?.preparation?.started_at,
      started,
      'a re-pend keeps the original start'
    )

    const next = await store.preparations.claimNext()
    assert.ok(next)
    assert.strictEqual(
      (await store.queries.getRun(runId))?.preparation?.started_at,
      started,
      'claiming again keeps the original start'
    )
  } finally {
    await store.close()
  }
})

test('an exhausted preparation keeps the last real failure reason instead of the lease code', async () => {
  // Walks the real coordinator path, because the interesting step is the one a bare SQL fixture
  // would skip: a retryable failure records the reason, then `claimNext` starts the next
  // attempt and clears the per-attempt failure fields. If that attempt's lease expires on the
  // final allowed attempt, the only surviving record of the real cause is
  // `last_failure_code`; without it the user is told "lease expired" and loses the actionable
  // reason.
  const store = await createStore({ claimTimeoutMs: 1 })
  const runId = `run-${randomUUID()}`
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.preparations.fail(
      runId,
      admission.preparation_token,
      { code: 'GITHUB_RATE_LIMITED', message: 'rate limited' },
      { retry: true }
    )

    // The coordinator claims the retry. This is the step that erases `failure_code`.
    const work = await store.preparations.claimNext()
    assert.strictEqual(work?.run_id, runId)
    const afterClaim = await pool.query<{
      failure_code: string | null
      last_failure_code: string | null
    }>(
      'SELECT failure_code, last_failure_code FROM preparations WHERE run_id=$1',
      [runId]
    )
    assert.strictEqual(
      afterClaim.rows[0]?.failure_code,
      null,
      'a new attempt starts without a current failure'
    )
    assert.strictEqual(
      afterClaim.rows[0]?.last_failure_code,
      'GITHUB_RATE_LIMITED',
      'the durable reason must survive the claim that clears failure_code'
    )

    // That attempt dies on its final allowed lease.
    await pool.query(
      `UPDATE preparations
         SET attempt_count=8, claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    await store.preparations.expireStale()

    const preparation = await pool.query<{
      status: string
      failure_code: string | null
      failure_message: string | null
    }>(
      'SELECT status, failure_code, failure_message FROM preparations WHERE run_id=$1',
      [runId]
    )
    assert.strictEqual(preparation.rows[0]?.status, 'failed')
    assert.strictEqual(
      preparation.rows[0]?.failure_code,
      'GITHUB_RATE_LIMITED',
      'the real failure reason must survive the lease expiry'
    )
    assert.strictEqual(preparation.rows[0]?.failure_message, 'rate limited')

    // The publication axis moved in the same pass, and its event names the state it actually
    // left. On this path that is always `pending`: a publication only reaches `publishing` after
    // execution succeeded, and this pass only concludes runs whose execution is still pending.
    // The helper still reports the origin instead of assuming it, so an in-flight publication
    // converged through some other write path cannot be misreported - but that case is not
    // reachable here, so this assertion pins the reachable behaviour only.
    const publicationEvents = (await store.queries.listEvents(runId))
      .filter((event) => event.axis === 'publication')
      .map((event) => `${event.from_status}->${event.to_status}`)
    assert.deepStrictEqual(publicationEvents, [
      'null->pending',
      'pending->skipped'
    ])

    const notice = await store.notices.claimNext()
    assert.ok(notice)
    assert.strictEqual(notice.reason_code, 'GITHUB_RATE_LIMITED')
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a preparation failure with no recorded reason still reports the exhaustion code', async () => {
  // The complement of the test above: when no attempt ever recorded a code, the generic
  // exhaustion reason is the honest answer.
  const store = await createStore({ claimTimeoutMs: 1 })
  const runId = `run-${randomUUID()}`
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await pool.query(
      `UPDATE preparations
         SET attempt_count=8, claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    await store.preparations.expireStale()

    const notice = await store.notices.claimNext()
    assert.ok(notice)
    assert.strictEqual(notice.reason_code, 'PREPARATION_RETRY_EXHAUSTED')
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a terminal execution failure converges an in-flight publication', async () => {
  // Publication is only claimed after execution succeeded, so this combination needs a forced
  // repair (or a future write path) to occur. If it did, leaving publication `publishing` would
  // strand the row forever: complete and fail both require the claim token, and the axis has no
  // writer left. The execution-failure path must converge it to `skipped` and fence the claim.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)

    // Force execution back to a non-terminal-but-failable state, then fail it.
    const pool = new Pool({ connectionString: requireTestDatabase() })
    try {
      await pool.query(
        `UPDATE executions SET status='running', finished_at=NULL WHERE run_id=$1`,
        [runId]
      )
    } finally {
      await pool.end()
    }
    assert.strictEqual(
      await store.failExecution(runId, {
        code: 'EXECUTION_LOST',
        message: 'expected output'
      }),
      true
    )

    const record = await store.queries.getRun(runId)
    assert.strictEqual(record?.execution.status, 'failed')
    assert.strictEqual(
      record?.publication.status,
      'skipped',
      'a publication in flight must not be stranded when execution fails'
    )
    assert.strictEqual(record?.publication.finished_at !== null, true)

    const events = await store.queries.listEvents(runId)
    const abandoned = events.find(
      (event) =>
        event.axis === 'publication' &&
        event.from_status === 'publishing' &&
        event.to_status === 'skipped'
    )
    assert.ok(abandoned, 'the abandonment must be audited')
    assert.strictEqual(abandoned.reason_code, 'PUBLICATION_ABANDONED')
  } finally {
    await store.close()
  }
})

test('a rejected submission replay converges an in-flight publication', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)

    const pool = new Pool({ connectionString: requireTestDatabase() })
    try {
      await pool.query(
        // `uncertain` has neither bound: the submission may never have been accepted. No claim
        // is needed either; a missing claim is exactly the recoverable state.
        `UPDATE executions
           SET status='uncertain', started_at=NULL, finished_at=NULL,
               workflow_result=NULL, claim_token=NULL, claimed_at=NULL
         WHERE run_id=$1`,
        [runId]
      )
    } finally {
      await pool.end()
    }
    const claimToken = await store.executions.claimSubmissionRecovery(runId)
    assert.notStrictEqual(claimToken, null)
    assert.strictEqual(
      await store.submissionTransitions.failSubmissionRecovery(
        runId,
        claimToken as string,
        {
          code: 'SUBMISSION_REJECTED',
          message: 'replay rejected'
        }
      ),
      true
    )

    const record = await store.queries.getRun(runId)
    assert.strictEqual(record?.execution.status, 'failed')
    assert.strictEqual(record?.publication.status, 'skipped')
  } finally {
    await store.close()
  }
})

test('a failed publication reports its own reason, never another axis', async () => {
  // `publication: failed` is the terminal outcome. Its run-level failure code must come from
  // the publication row: borrowing an execution or preparation code would name a cause that
  // did not stop the run, and a publication with no code must read as "no code", not as
  // somebody else's failure.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)
    assert.strictEqual(
      await store.publications.fail(
        runId,
        token as string,
        { code: null, message: 'no code' },
        { retry: false }
      ),
      true
    )
    const noCode = await store.queries.getRun(runId)
    assert.strictEqual(noCode?.publication.status, 'failed')
    assert.strictEqual(noCode?.failure_code, null)
  } finally {
    await store.close()
  }

  const second = await createStore()
  const secondRunId = await createSuccessfulRun(second)
  try {
    const token = await second.publicationClaims.claim(secondRunId)
    assert.notStrictEqual(token, null)
    await second.publications.fail(
      secondRunId,
      token as string,
      { code: 'GITHUB_FORBIDDEN', message: 'forbidden' },
      { retry: false }
    )
    const record = await second.queries.getRun(secondRunId)
    assert.strictEqual(record?.failure_code, 'GITHUB_FORBIDDEN')
  } finally {
    await second.close()
  }
})

test('an accepted replay refuses to queue an execution whose publication already ended', async () => {
  // `completeSubmissionRecovery` moves only the execution axis because an uncertain submission
  // keeps publication `pending`. That used to be an assumption, not a checked precondition: if a
  // publication were concluded by any path before the replay resolved, queueing the execution
  // would produce a run that is running while its result can never be delivered. The write path
  // now asserts the premise and reports a lost claim instead of committing that snapshot.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const admitted = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admitted.preparation_token)
    await store.preparations.fail(
      runId,
      admitted.preparation_token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    // Force the inconsistent state a stable write path cannot reach: publication is concluded
    // while the execution is still `uncertain`.
    await pool.query(
      `UPDATE publications SET status='skipped', finished_at=clock_timestamp()
       WHERE run_id=$1`,
      [runId]
    )

    const token = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(token)
    assert.strictEqual(
      await store.submissionTransitions.completeSubmissionRecovery(
        runId,
        token
      ),
      false,
      'an accepted replay must not queue an execution whose publication is gone'
    )
    const record = await store.queries.getRun(runId)
    assert.strictEqual(
      record?.execution.status,
      'uncertain',
      'a refused replay must leave the execution axis untouched'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('markQueued refuses to submit into a publication that already ended', async () => {
  // `markQueued` is the normal submission entry point, so it must hold the same invariant the
  // replay path asserts: an execution may only be queued while publication is still `pending`.
  // It used to check the workflow but not the publication status, so an out-of-band conclusion
  // (forced repair, or a future write path) let it record `execution=queued` next to a terminal
  // publication — a run that is running while its result can never be delivered.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    // Positive control: the untouched publication is `pending`, so the submit succeeds.
    const admitted = `run-${randomUUID()}`
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: admitted,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.submissionTransitions.markQueued(
      admitted,
      admission.preparation_token,
      {}
    )
    assert.strictEqual(
      (await store.queries.getRun(admitted))?.execution.status,
      'queued'
    )

    // Negative: once publication is concluded, the same submit must fail and roll back whole.
    const refused = `run-${randomUUID()}`
    const refusedAdmission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: refused,
      publish_context: {}
    })
    assert.ok(refusedAdmission.preparation_token)
    await pool.query(
      `UPDATE publications SET status='skipped', finished_at=clock_timestamp()
       WHERE run_id=$1`,
      [refused]
    )
    await assert.rejects(
      store.submissionTransitions.markQueued(
        refused,
        refusedAdmission.preparation_token,
        {}
      ),
      /cannot transition from pending to queued/,
      'a concluded publication must reject the submission'
    )
    const record = await store.queries.getRun(refused)
    assert.strictEqual(
      record?.execution.status,
      'pending',
      'the refused submission must leave the execution unqueued'
    )
    assert.strictEqual(
      record?.preparation.status,
      'preparing',
      'the refused submission must leave the preparation claim intact'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a preparation failure becomes a no-op when its claim is fenced mid-transaction', async () => {
  // `failPreparation` closes the preparation row first, and that UPDATE doubles as the claim
  // check: it only matches while the row is still `preparing` under our token. If another writer
  // (an expired lease in `expireStale`) replaces the row before it runs, the UPDATE matches
  // nothing. The stale owner must not record `preparing -> failed` on a claim that is no longer
  // ours, but losing the fence is a normal concurrent outcome rather than a server error.
  //
  // A trigger stands in for that writer by rewriting the row just before the statement that
  // checks it, which is exactly the window a concurrent lease expiry occupies. A normal call
  // cannot produce this interleaving, so the trigger is what makes the race deterministic.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_steal_preparation_claim() RETURNS trigger AS $$
      BEGIN
        -- Skip the caller's update, which is what happens when another connection replaced the
        -- row between this statement's snapshot and its write: the predicate no longer holds, so
        -- the row is not touched and the statement reports zero rows.
        IF OLD.status = 'preparing' AND NEW.status = 'failed' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await pool.query(`
      CREATE TRIGGER test_steal_preparation_claim_trigger
      BEFORE UPDATE ON preparations
      FOR EACH ROW EXECUTE FUNCTION test_steal_preparation_claim();
    `)
    try {
      assert.deepStrictEqual(
        await store.preparations.fail(
          runId,
          admission.preparation_token,
          { code: 'PREPARATION_INPUT_INVALID', message: 'cannot build input' },
          { retry: false }
        ),
        { retry_scheduled: false },
        'a fenced owner must report that it scheduled no retry'
      )
      // The preparation keeps the state the competing writer left, and no audit event claims a
      // transition this invocation did not make.
      const record = await store.queries.getRun(runId)
      assert.strictEqual(
        record?.preparation.status,
        'preparing',
        'a lost claim must not be recorded as a terminal failure'
      )
      assert.strictEqual(record?.execution.status, 'pending')
      assert.deepStrictEqual(
        (await store.queries.listEvents(runId)).map(
          (event) => `${event.axis}:${event.to_status}`
        ),
        ['execution:pending', 'preparation:preparing', 'publication:pending'],
        'the refused failure must not append a misleading event'
      )
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS test_steal_preparation_claim_trigger ON preparations'
      )
      await pool.query('DROP FUNCTION IF EXISTS test_steal_preparation_claim()')
    }
  } finally {
    await pool.end()
    await store.close()
  }
})

test('savePreparedSubmission rolls the publication write back when the execution arm misses', async () => {
  // The statement is one data-modifying CTE, but a single statement is not atomic across its
  // arms: the publication UPDATE runs even when the execution UPDATE matches nothing, and the
  // trailing SELECT only decides how many rows come back. Checking the row count on a bare
  // `pool.query` therefore threw after the publication's new input had already committed,
  // leaving a publication carrying input for a run whose execution never got it. The write is
  // now wrapped in a transaction so the failed check undoes the publication arm too.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: { target: 'original' }
    })
    assert.ok(admission.preparation_token)
    // Make the execution arm miss while the publication arm still matches: the preparation is no
    // longer `preparing`, so its EXISTS is false, but the run trunk still authorizes the update.
    await pool.query(
      `UPDATE preparations SET status='failed', claim_token=NULL, claimed_at=NULL,
         failure_code='PREPARATION_FAILED', failure_message='x',
         finished_at=clock_timestamp()
       WHERE run_id=$1`,
      [runId]
    )
    const before = await pool.query<{ input: Record<string, unknown> }>(
      'SELECT input FROM publications WHERE run_id=$1',
      [runId]
    )

    await assert.rejects(
      store.submissionTransitions.savePreparedSubmission(
        runId,
        admission.preparation_token,
        { target: 'overwritten' },
        { api_version: 'v1' }
      ),
      /Preparation claim was lost/,
      'a missed execution arm must reject the save'
    )

    const after = await pool.query<{ input: Record<string, unknown> }>(
      'SELECT input FROM publications WHERE run_id=$1',
      [runId]
    )
    assert.deepStrictEqual(
      after.rows[0]?.input,
      before.rows[0]?.input,
      'the rejected save must not leave the publication input half-written'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a publisher that died mid-publication is taken over once its lease expires', async () => {
  // A publication is not stranded by a crashed publisher: `publishing` with an expired
  // `claimed_at` is claimable again, which is the only reason the claim token exists. This pins
  // that self-healing path - including the takeover event and the stale owner being fenced out -
  // because it is what makes an operator repair unnecessary in the common case.
  const store = await createStore({ claimTimeoutMs: 50 })
  const runId = await createSuccessfulRun(store)
  try {
    const firstToken = await store.publicationClaims.claim(runId)
    assert.ok(firstToken)
    // The lease is still fresh, so nobody else may take it.
    assert.strictEqual(await store.publicationClaims.claim(runId), null)

    await new Promise((resolve) => setTimeout(resolve, 120))
    const secondToken = await store.publicationClaims.claim(runId)
    assert.ok(secondToken, 'an expired lease must be reclaimable')
    assert.notStrictEqual(secondToken, firstToken)

    // The old owner is fenced out at every write.
    assert.strictEqual(
      await store.publications.complete(runId, firstToken),
      false
    )
    await assert.rejects(
      store.publications.requirePublicationStepClaim(runId, firstToken, 'x')
    )

    // The new owner finishes the publication.
    await store.publications.initializePublicationSteps(runId, secondToken, [
      'x'
    ])
    await store.publications.requirePublicationStepClaim(
      runId,
      secondToken,
      'x'
    )
    await store.publications.completePublicationStep(runId, secondToken, 'x')
    assert.strictEqual(
      await store.publications.complete(runId, secondToken),
      true
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'published'
    )

    // The takeover is auditable, not silent.
    const publicationEvents = (await store.queries.listEvents(runId))
      .filter((event) => event.axis === 'publication')
      .map((event) => `${event.from_status}->${event.to_status}`)
    assert.deepStrictEqual(publicationEvents, [
      'null->pending',
      'pending->publishing',
      'publishing->publishing',
      'publishing->published'
    ])
  } finally {
    await store.close()
  }
})

test('reclaiming a running publication step records that another attempt started', async () => {
  // A step found `running` belongs to a publisher that may have died mid-effect. Review Runs
  // cannot know whether the side effect happened, so it must not let a reclaim look like a first
  // attempt: `attempt_count` and `last_attempt_at` are what let the connector treat a reclaim as
  // a retry and reconcile against the remote object instead of repeating the call blindly.
  const store = await createStore({ claimTimeoutMs: 50 })
  const runId = await createSuccessfulRun(store)
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, [
      'comment'
    ])
    assert.strictEqual(
      (await store.publications.listPublicationSteps(runId))[0]?.attempt_count,
      0,
      'an untouched step has never been attempted'
    )

    await store.publications.requirePublicationStepClaim(
      runId,
      token,
      'comment'
    )
    const first = (await store.publications.listPublicationSteps(runId))[0]
    assert.strictEqual(first?.attempt_count, 1)
    assert.ok(
      first?.last_attempt_at,
      'the first attempt records when it started'
    )

    // The publisher "dies" here: the step stays `running`. A new owner reclaims it once the
    // publication lease expires.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const secondToken = await store.publicationClaims.claim(runId)
    assert.ok(secondToken)
    await store.publications.requirePublicationStepClaim(
      runId,
      secondToken,
      'comment'
    )
    const second = (await store.publications.listPublicationSteps(runId))[0]
    assert.strictEqual(
      second?.attempt_count,
      2,
      'a reclaim must be visible as a second attempt, not a first one'
    )
    assert.strictEqual(second?.status, 'running')
    assert.notStrictEqual(second?.last_attempt_at, null)
  } finally {
    await pool.end()
    await store.close()
  }
})

test('an unreconcilable expiry blocks one run instead of aborting the pass forever', async () => {
  // A run whose execution already reached a terminal state while its preparation still holds an
  // expired `preparing` lease cannot be concluded: a preparation failure would have to overwrite
  // a real Execution result. The old behaviour threw from inside the shared expiry transaction, and
  // because coordination expires preparations *first*, every pass rolled back before recovering
  // submissions or observing active runs. One corrupt run therefore starved every other run, on
  // every tick, with the same error. This pins the fix: the bad run is marked and skipped, the
  // healthy run is still concluded, and the next pass does not retry the bad one.
  const store = await createStore({ claimTimeoutMs: 0 })
  const pool = new Pool({ connectionString: requireTestDatabase() })
  const corruptRunId = `run-corrupt-${randomUUID()}`
  const healthyRunId = `run-healthy-${randomUUID()}`
  try {
    for (const runId of [corruptRunId, healthyRunId]) {
      await store.admissions.create({
        workflow: 'issue-review',
        run_id: runId,
        publish_context: {}
      })
      await pool.query(
        `UPDATE preparations SET attempt_count=8,
           claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
        [runId]
      )
    }
    // Give the corrupt run an execution that preparation failure can no longer explain. Its
    // publication is left in flight too, so a naive repair would also have to fence it.
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{"ok":true}'::jsonb
       WHERE run_id=$1`,
      [corruptRunId]
    )
    const livePublicationToken = randomUUID()
    await pool.query(
      `UPDATE publications SET status='publishing', claim_token=$2,
         claimed_at=clock_timestamp(), started_at=clock_timestamp() WHERE run_id=$1`,
      [corruptRunId, livePublicationToken]
    )

    const first = await store.preparations.expireStale()
    assert.strictEqual(first.concluded, 1, 'the healthy run is still concluded')
    assert.deepStrictEqual(first.blocked, [
      { run_id: corruptRunId, reason: 'EXECUTION_ALREADY_ADVANCED' }
    ])

    // The healthy run is fully concluded even though a sibling failed.
    const healthy = await store.queries.getRun(healthyRunId)
    assert.strictEqual(healthy?.preparation?.status, 'failed')
    assert.strictEqual(healthy?.execution.status, 'skipped')
    assert.strictEqual(healthy?.publication.status, 'skipped')

    // The corrupt run becomes `disconnected` and nothing else about it is rewritten: the
    // contradiction stays visible, and the state itself is what tells an operator to look.
    const corrupt = await store.queries.getRun(corruptRunId)
    assert.strictEqual(corrupt?.preparation?.status, 'disconnected')
    assert.strictEqual(
      corrupt?.preparation?.disconnect_reason,
      'EXECUTION_ALREADY_ADVANCED'
    )
    assert.strictEqual(corrupt?.execution.status, 'succeeded')
    assert.strictEqual(corrupt?.publication.status, 'publishing')

    // The block is durable: a later pass neither retries nor re-reports the same row. Without
    // this, every tick would repeat the failing transition forever.
    const second = await store.preparations.expireStale()
    assert.strictEqual(second.concluded, 0)
    assert.deepStrictEqual(second.blocked, [])

    const marker = await pool.query<{
      status: string
      disconnect_reason: string | null
    }>(`SELECT status, disconnect_reason FROM preparations WHERE run_id=$1`, [
      corruptRunId
    ])
    assert.strictEqual(marker.rows[0]?.status, 'disconnected')
    assert.strictEqual(
      marker.rows[0]?.disconnect_reason,
      'EXECUTION_ALREADY_ADVANCED'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a blocked expiry does not stop the rest of the coordination pass', async () => {
  // The expiry call is the first step of a pass. Before per-row isolation it could throw, which
  // took submission recovery and active observation down with it. This drives a real pass with a
  // blocked run present and asserts the pass still reaches the later steps.
  const sharedConnector = `blocked-pass:${randomUUID()}`
  const store = await createStore({
    connectorId: sharedConnector,
    claimTimeoutMs: 0
  })
  const pool = new Pool({ connectionString: requireTestDatabase() })
  const corruptRunId = `run-corrupt-${randomUUID()}`
  const activeRunId = `run-active-${randomUUID()}`
  try {
    // Keep the active run's admission token: `claimNextPreparation` would hand back whichever
    // run sorted first, and the corrupt one must stay unclaimed to keep its expiry pending.
    const activeAdmission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: activeRunId,
      publish_context: {}
    })
    await store.submissionTransitions.markQueued(
      activeRunId,
      activeAdmission.preparation_token!,
      {}
    )
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: corruptRunId,
      publish_context: {}
    })
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{"ok":true}'::jsonb
       WHERE run_id=$1`,
      [corruptRunId]
    )
    await pool.query(
      `UPDATE preparations SET attempt_count=8,
         claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [corruptRunId]
    )

    const blocked: string[] = []
    const observed: string[] = []
    await coordinateReviewRunsOnce(store, {
      async recoverSubmission() {},
      async readExecutionStatuses() {
        return { runs: [], missing: [], byRunId: new Map() }
      },
      async observeActiveRun(run) {
        observed.push(run.run_id)
      },
      onDroppedRunRow(dropped) {
        throw dropped.error
      },
      onBlockedPreparationExpiry(report) {
        blocked.push(`${report.run_id}:${report.reason}`)
      }
    })

    assert.deepStrictEqual(blocked, [
      `${corruptRunId}:EXECUTION_ALREADY_ADVANCED`
    ])
    assert.deepStrictEqual(
      observed,
      [activeRunId],
      'the pass still observes active runs after a blocked expiry'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('abandoning a disconnected run concludes its open axes and keeps the execution evidence', async () => {
  // The operator path for a disconnected run. It is an abandonment, not a repair: the open axes are
  // concluded so the run stops holding work nobody can conclude, while the execution axis keeps
  // the result the Execution actually produced. Nothing is deleted, and the ingress identity stays,
  // so a replay of the same webhook resolves to this run instead of starting a second one.
  const store = await createStore({ claimTimeoutMs: 0 })
  const pool = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-blocked-${randomUUID()}`
  const ingress = {
    kind: 'github_webhook' as const,
    key: `delivery-${randomUUID()}`
  }
  try {
    await store.admissions.admit({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: ingress.kind,
      ingress_key: ingress.key
    })
    await pool.query(
      `UPDATE preparations SET attempt_count=8,
         claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{"keep":true}'::jsonb
       WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE publications SET status='publishing', claim_token=$2,
         claimed_at=clock_timestamp(), started_at=clock_timestamp() WHERE run_id=$1`,
      [runId, randomUUID()]
    )
    const expiry = await store.preparations.expireStale()
    assert.deepStrictEqual(expiry.blocked, [
      { run_id: runId, reason: 'EXECUTION_ALREADY_ADVANCED' }
    ])
    const parked = await store.queries.listParkedRuns()
    assert.strictEqual(parked.length, 1)
    assert.strictEqual(parked[0]?.run_id, runId)
    assert.strictEqual(parked[0]?.axis, 'preparation')
    assert.strictEqual(parked[0]?.reason, 'EXECUTION_ALREADY_ADVANCED')
    const disconnectEvent = (await store.queries.listEvents(runId)).find(
      (event) =>
        event.axis === 'preparation' && event.to_status === 'disconnected'
    )
    assert.ok(disconnectEvent, 'the park must leave a transition event')
    assert.strictEqual(
      new Date(parked[0]?.parked_at ?? 0).toISOString(),
      new Date(disconnectEvent.occurred_at).toISOString(),
      'parked_at must be the transition instant, not a later activity timestamp'
    )

    // A blank reason is refused: an abandonment must always say why it happened.
    await assert.rejects(
      store.operatorDecisions.abandonBlockedPreparation(runId, '   '),
      /reason is required/
    )
    // A run that is not blocked cannot be abandoned through this path, which is what keeps it
    // from becoming a general state-jumping endpoint.
    await assert.rejects(
      store.operatorDecisions.abandonBlockedPreparation(
        `run-${randomUUID()}`,
        'not blocked'
      ),
      /is not a disconnected preparation/
    )

    const abandoned = await store.operatorDecisions.abandonBlockedPreparation(
      runId,
      'execution result will not be delivered'
    )
    assert.strictEqual(abandoned.preparation.status, 'failed')
    // The abandonment records the reason the row was parked under, which is the reason the
    // contract declares for `disconnected -> failed` on this axis. Inventing a second code here
    // would put a reason in the audit log that no declared edge names.
    assert.strictEqual(
      abandoned.preparation.failure_code,
      'EXECUTION_ALREADY_ADVANCED'
    )
    assert.strictEqual(abandoned.publication.status, 'skipped')
    // The execution result is evidence, not an error to clear.
    assert.strictEqual(abandoned.execution.status, 'succeeded')

    const stored = await pool.query<{ workflow_result: unknown }>(
      'SELECT workflow_result FROM executions WHERE run_id=$1',
      [runId]
    )
    assert.deepStrictEqual(stored.rows[0]?.workflow_result, { keep: true })

    // The block marker is gone, so coordination no longer skips the run, and the abandonment is
    // on the record with its reason.
    assert.deepStrictEqual(await store.queries.listParkedRuns(), [])
    const events = await store.queries.listEvents(runId)
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'preparation' &&
          event.to_status === 'failed' &&
          event.reason_code === 'EXECUTION_ALREADY_ADVANCED'
      )
    )
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'publication' &&
          (event.from_status === 'publishing' ||
            event.from_status === 'pending') &&
          event.to_status === 'skipped'
      )
    )

    // Nothing was deleted: the same ingress identity still resolves to this run.
    const replay = await store.admissions.admit({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {},
      ingress_kind: ingress.kind,
      ingress_key: ingress.key
    })
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.record.run_id, runId)
    assert.strictEqual(replay.record.preparation.status, 'failed')
  } finally {
    await pool.end()
    await store.close()
  }
})

test('resuming a disconnected run grants a fresh attempt budget, not just a fresh status', async () => {
  // The regression this prevents: disconnection is reached exactly when the attempt budget is
  // spent, so a resumed row that kept its count would be concluded as `failed` by the very next
  // expired lease, and the operator's decision would never get a single attempt. Resuming must
  // therefore move the row to `uncertain` AND zero `attempt_count`.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = `run-${randomUUID()}`
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    // Arrange the contradictory state disconnection exists for: an expired `preparing` lease
    // whose execution has already left `pending`, with the budget fully spent.
    await pool.query(
      `UPDATE preparations SET attempt_count=8,
         claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{}'::jsonb WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual(
      (await store.preparations.expireStale()).blocked.length,
      1
    )
    const attention = await store.notices.claimNext()
    assert.ok(attention)
    assert.strictEqual(attention.run_id, runId)
    assert.strictEqual(attention.axis, 'preparation')
    assert.strictEqual(attention.kind, 'attention')

    // A run that never disconnected is refused the same way abandonment refuses one.
    await assert.rejects(
      store.operatorDecisions.resumeDisconnectedPreparation(
        `run-${randomUUID()}`
      ),
      (error: unknown) => {
        assert.strictEqual((error as { statusCode?: number }).statusCode, 409)
        return true
      }
    )

    const resumed =
      await store.operatorDecisions.resumeDisconnectedPreparation(runId)
    assert.strictEqual(resumed.preparation.status, 'uncertain')
    assert.strictEqual(resumed.preparation.disconnect_reason, null)
    assert.strictEqual(
      resumed.preparation.attempt_count,
      0,
      'a resumed row must get a budget it can actually act on'
    )
    const superseded = await pool.query<{
      status: string
      claim_token: string | null
      claimed_at: string | null
    }>(
      `SELECT status,claim_token,claimed_at FROM run_notices
       WHERE notice_id=$1 AND run_id=$2`,
      [attention.notice_id, runId]
    )
    assert.deepStrictEqual(superseded.rows[0], {
      status: 'superseded',
      claim_token: null,
      claimed_at: null
    })
    assert.strictEqual(
      await store.notices.renewClaim(
        attention.notice_id,
        attention.claim_token
      ),
      false,
      'resuming fences the connector that claimed the old attention notice'
    )
    assert.strictEqual(
      await store.notices.complete(
        attention.notice_id,
        attention.claim_token,
        true,
        'https://github.com/example/example/issues/1#issuecomment-1'
      ),
      false
    )
    // The run left the operator queue, and the decision is on the record.
    assert.deepStrictEqual(await store.queries.listParkedRuns(), [])
    const events = await store.queries.listEvents(runId)
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'preparation' &&
          event.from_status === 'disconnected' &&
          event.to_status === 'uncertain' &&
          event.reason_code === 'PREPARATION_RESUMED_BY_OPERATOR'
      )
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a disconnected execution has no automatic way out, so an operator resumes it', async () => {
  // Regression: once execution disconnects, `claimSubmissionRecovery` no longer matches it (it
  // only takes `uncertain`) and no automatic selector picks a `disconnected` execution, so
  // without an operator resume the run would be stuck forever with no owner and no writer. The
  // resume must also reset the replay budget, or the next coordination pass would disconnect it
  // again before a single replay happened.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = `run-${randomUUID()}`
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await store.preparations.fail(
      runId,
      admission.preparation_token as string,
      {
        code: 'SUBMISSION_STATE_UNCERTAIN',
        message: 'unknown'
      }
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.execution.status,
      'uncertain'
    )

    // A budget that has not been spent leaves the run to normal replay; only a spent budget
    // disconnects it.
    assert.strictEqual(
      await store.executions.disconnectExhaustedSubmissionRecovery(runId, 8),
      false,
      'a run that has not spent its budget is not disconnected'
    )
    assert.strictEqual(
      await store.executions.disconnectExhaustedSubmissionRecovery(runId, 0),
      true,
      'a spent budget disconnects the run'
    )
    const attention = await store.notices.claimNext()
    assert.ok(attention)
    assert.strictEqual(attention.run_id, runId)
    assert.strictEqual(attention.axis, 'execution')
    assert.strictEqual(attention.kind, 'attention')
    assert.strictEqual(
      (await store.queries.getRun(runId))?.execution.status,
      'disconnected'
    )
    assert.strictEqual(
      await store.executions.claimSubmissionRecovery(runId),
      null,
      'a disconnected execution is not claimable by automatic recovery'
    )

    const resumed = await store.operatorDecisions.resumeDisconnectedRun(runId)
    assert.strictEqual(resumed.execution.status, 'uncertain')
    const superseded = await pool.query<{
      status: string
      claim_token: string | null
      claimed_at: string | null
    }>(
      `SELECT status,claim_token,claimed_at FROM run_notices
       WHERE notice_id=$1 AND run_id=$2`,
      [attention.notice_id, runId]
    )
    assert.deepStrictEqual(superseded.rows[0], {
      status: 'superseded',
      claim_token: null,
      claimed_at: null
    })
    assert.strictEqual(
      await store.notices.renewClaim(
        attention.notice_id,
        attention.claim_token
      ),
      false
    )
    assert.strictEqual(
      await store.executions.submissionRecoveryAttemptCount(runId),
      0,
      'resuming grants a replay budget the run can act on'
    )
    assert.notStrictEqual(
      await store.executions.claimSubmissionRecovery(runId),
      null,
      'the resumed run is claimable again'
    )
    const events = await store.queries.listEvents(runId)
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'execution' &&
          event.from_status === 'disconnected' &&
          event.to_status === 'uncertain' &&
          event.reason_code === 'SUBMISSION_RECOVERY_RESUMED_BY_OPERATOR'
      )
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('giving up on a disconnected execution stops waiting without claiming it never ran', async () => {
  // The decision this covers is "we will not wait for this outcome", not "the task never ran".
  // The Execution may have accepted and be executing the task right now, so the failure code has to
  // name the decision, and publication must be skipped for "no result to deliver" rather than
  // for "nothing was produced".
  const store = await createStore()
  try {
    const runId = `run-${randomUUID()}`
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await store.preparations.fail(
      runId,
      admission.preparation_token as string,
      {
        code: 'SUBMISSION_STATE_UNCERTAIN',
        message: 'unknown'
      }
    )
    assert.strictEqual(
      await store.executions.disconnectExhaustedSubmissionRecovery(runId, 0),
      true
    )

    await assert.rejects(
      store.operatorDecisions.giveUpDisconnectedRun(runId, '   '),
      (error: unknown) => {
        assert.strictEqual((error as { statusCode?: number }).statusCode, 400)
        return true
      }
    )

    const givenUp = await store.operatorDecisions.giveUpDisconnectedRun(
      runId,
      'operator stopped'
    )
    assert.strictEqual(givenUp.execution.status, 'failed')
    assert.strictEqual(
      givenUp.failure_code,
      'SUBMISSION_RECOVERY_ABANDONED_BY_OPERATOR',
      'the code names the decision, not an unproven "never ran"'
    )
    assert.strictEqual(givenUp.publication.status, 'skipped')
    // A failure notice is queued so the requester learns the outcome was abandoned, and it is a
    // failure (not an attention notice): the run is over.
    assert.ok(
      givenUp.notices.some(
        (notice) => notice.axis === 'execution' && notice.kind === 'failure'
      )
    )
    // The decision is final: neither resuming nor giving up again applies.
    await assert.rejects(
      store.operatorDecisions.resumeDisconnectedRun(runId),
      (error: unknown) => {
        assert.strictEqual((error as { statusCode?: number }).statusCode, 409)
        return true
      }
    )
  } finally {
    await store.close()
  }
})

test('giving up on a disconnected publication fails rather than skipping', async () => {
  // A step in this state may already have taken effect on GitHub, so the axis must not report
  // "skipped" — that reads as "nothing was published". It fails, which says publishing stopped
  // while what is actually on the remote system remains unknown, and the step keeps its own
  // status as the record of that.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    await store.publications.initializePublicationSteps(
      runId,
      token as string,
      ['issue:summary-comment']
    )
    await store.publications.requirePublicationStepClaim(
      runId,
      token as string,
      'issue:summary-comment'
    )
    const claim = async (): Promise<void> => {
      await store.publications
        .requirePublicationStepClaim(
          runId,
          token as string,
          'issue:summary-comment'
        )
        .catch(() => undefined)
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await store.publications.failPublicationStep(
        runId,
        token as string,
        'issue:summary-comment',
        { code: 'GITHUB_TIMEOUT', message: 'no answer' },
        { retry: true }
      )
      const status = (
        (await store.publications.listPublicationSteps(runId))[0] as {
          status: string
        }
      ).status
      if (status === 'disconnected') break
      await claim()
    }
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'disconnected'
    )

    const givenUp = await store.operatorDecisions.giveUpDisconnectedRun(
      runId,
      'operator stopped'
    )
    assert.strictEqual(givenUp.publication.status, 'failed')
    assert.strictEqual(
      givenUp.failure_code,
      'PUBLICATION_ABANDONED_BY_OPERATOR'
    )
    // The step is untouched: it is the record of which side effect could not be confirmed.
    assert.strictEqual(
      (
        (await store.publications.listPublicationSteps(runId))[0] as {
          status: string
        }
      ).status,
      'disconnected'
    )
    await pool.end()
  } finally {
    await store.close()
  }
})

test('an operator resume publishes the parked steps again instead of only reconciling', async () => {
  // The contract calls the publication branch of resume "published again": the operator is
  // handing this run back to automatic recovery, the same way the preparation and execution
  // branches reset the budget that made their axis stop. A resume that only refreshes the
  // reconciliation budget cannot publish again - the attempt budget is what refuses the write,
  // and a spent budget means the connector may only look, so a step it finds absent ends the
  // publication instead of retrying it. That is "keep publishing", not "publish again".
  //
  // The operator decision therefore returns the attempt budget as well, so the next owner may
  // write the side effect again. It is not capped: the admin token is the operator's own
  // authority, and what the system owes them is a record of each decision, not a limit on it.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)
    await store.publications.initializePublicationSteps(
      runId,
      token as string,
      ['issue:summary-comment']
    )
    await store.publications.requirePublicationStepClaim(
      runId,
      token as string,
      'issue:summary-comment'
    )
    // The publisher exhausted its attempts and the reconciliation budget, so the step parked.
    await pool.query(
      `UPDATE publication_steps SET status='disconnected', attempt_count=3,
         recovery_attempt_count=3, claimed_by=NULL WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE publications SET status='disconnected', claim_token=NULL, claimed_at=NULL
       WHERE run_id=$1`,
      [runId]
    )

    await store.operatorDecisions.resumeDisconnectedRun(runId)
    const revived = (
      await pool.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM publication_steps WHERE run_id=$1`,
        [runId]
      )
    ).rows[0]
    assert.strictEqual(
      revived?.status,
      'pending',
      'the parked step is attemptable again, not merely reconcilable'
    )
    assert.strictEqual(
      revived?.attempt_count,
      0,
      'the operator decision returns the attempt budget, so the step may be published again'
    )
    const resumedAxis = (
      await pool.query<{ status: string }>(
        `SELECT status FROM publications WHERE run_id=$1`,
        [runId]
      )
    ).rows[0]?.status
    assert.strictEqual(
      resumedAxis,
      'pending',
      'the axis returns to the normal claim queue without inventing an owner'
    )

    // The normal selector gives the real publisher the claim token it needs. The resume route
    // itself returns no credential and therefore must not leave a hidden live lease behind.
    const resumedToken = await store.publicationClaims.claim(runId)
    assert.ok(resumedToken)
    await store.publications.requirePublicationStepClaim(
      runId,
      resumedToken,
      'issue:summary-comment'
    )
    assert.strictEqual(
      (
        await pool.query<{ status: string }>(
          `SELECT status FROM publication_steps WHERE run_id=$1`,
          [runId]
        )
      ).rows[0]?.status,
      'running',
      'the resumed run publishes again instead of only reconciling'
    )

    // The operator's authority is not capped: parking the run again lets them hand it back again,
    // and each decision is recorded as its own event rather than being refused in advance.
    await pool.query(
      `UPDATE publication_steps SET status='disconnected', attempt_count=3, claimed_by=NULL
       WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE publications SET status='disconnected', claim_token=NULL, claimed_at=NULL
       WHERE run_id=$1`,
      [runId]
    )
    await store.operatorDecisions.resumeDisconnectedRun(runId)
    const resumedTwice = await store.queries.listEvents(runId)
    assert.strictEqual(
      resumedTwice.filter(
        (event) => event.reason_code === 'PUBLICATION_RESUMED_BY_OPERATOR'
      ).length,
      2,
      'each operator decision is on the record'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a takeover settles a step its predecessor left uncertain instead of failing the run', async () => {
  // The sequence the other tests stop short of: a publisher dies while a step is uncertain, its
  // lease expires, and another owner takes the publication over. The takeover re-derives the step
  // keys, re-claims the step, and - because the attempt budget is spent - is told to reconcile.
  // When the reconciliation finds the side effect, the publication must go on to publish.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)
    await store.publications.initializePublicationSteps(
      runId,
      token as string,
      ['issue:summary-comment']
    )
    await store.publications.requirePublicationStepClaim(
      runId,
      token as string,
      'issue:summary-comment'
    )
    // Spend the attempt budget and leave the step uncertain: the last attempt may or may not have
    // taken effect, and its publisher never concluded either way.
    await pool.query(
      `UPDATE publication_steps
       SET status='uncertain', attempt_count=3, claimed_by=NULL
       WHERE run_id=$1`,
      [runId]
    )
    await pool.query(
      `UPDATE publications SET status='uncertain',
         claimed_at=clock_timestamp()-($2*interval '1 millisecond'), claim_token=NULL
       WHERE run_id=$1`,
      [runId, 600_000]
    )

    const takeover = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(takeover, null, 'an expired lease is taken over')
    await store.publications.initializePublicationSteps(
      runId,
      takeover as string,
      ['issue:summary-comment']
    )

    await assert.rejects(
      store.publications.requirePublicationStepClaim(
        runId,
        takeover as string,
        'issue:summary-comment'
      ),
      (error: unknown) => {
        assert.strictEqual(
          (error as { code?: string }).code,
          'PUBLICATION_STEP_RETRY_EXHAUSTED',
          'a spent step is offered for reconciliation'
        )
        return true
      }
    )

    // The connector looked and found the comment: the step succeeded after all.
    assert.strictEqual(
      await store.publications.settleExhaustedPublicationStep(
        runId,
        takeover as string,
        'issue:summary-comment',
        {
          found: true,
          remote: { id: '42', url: 'https://example.test/c/42' }
        }
      ),
      true
    )
    assert.strictEqual(
      await store.publications.complete(runId, takeover as string),
      true,
      'the publication still finishes once its only step is settled'
    )
    const finalRun = await store.queries.getRun(runId)
    assert.strictEqual(finalRun?.publication.status, 'published')
    assert.strictEqual(finalRun?.failure_code, null, 'no failure was recorded')
  } finally {
    await pool.end()
    await store.close()
  }
})

test('an operator resume completes on a pool that has exactly one connection', async () => {
  // The resume is a decision the operator makes on a run nobody is working, but the database may
  // still be busy: a small pool is a normal deployment choice, and nothing stops the resume from
  // being the request that takes the last free connection. resumeDisconnectedPublication opens a
  // transaction, then calls a store method that opens its own; with one connection the inner
  // acquire waits for a connection the outer transaction will not release until the resume
  // returns, and the request hangs until the pool times out. Failing to resume is recoverable -
  // the operator can ask again - so the resume must give the connection back instead of
  // deadlocking on it.
  const smallPool = new Pool({
    connectionString: requireTestDatabase(),
    max: 1
  })
  const store = new ReviewRunStore({
    pool: smallPool,
    connectorId: connectorId()
  })
  await store.initialize()
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)
    await store.publications.initializePublicationSteps(
      runId,
      token as string,
      ['issue:summary-comment']
    )
    // Park the publication the way the connector does when it cannot conclude a step.
    await smallPool.query(
      `UPDATE publication_steps SET status='disconnected' WHERE run_id=$1`,
      [runId]
    )
    await smallPool.query(
      `UPDATE publications SET status='disconnected', claim_token=NULL, claimed_at=NULL
       WHERE run_id=$1`,
      [runId]
    )

    // A hang is the failure this test exists for, so bound it rather than waiting forever.
    const resumed = await Promise.race([
      store.operatorDecisions.resumeDisconnectedRun(runId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('resume did not return')), 5_000)
      )
    ])
    assert.strictEqual(
      (resumed as { publication: { status: string } }).publication.status,
      'pending',
      'the operator decision took effect'
    )
  } finally {
    await store.close()
  }
})

test('a disconnected publication is parked until an operator resumes it', async () => {
  // A step parked after its reconciliation budget ran out excludes the whole publication from
  // every automatic claim, which is what keeps a side effect with an unknown remote outcome from
  // being repeated. It also means nothing can ever retry the run, so the operator resume has to
  // return the publication to the normal claim queue.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)
    await store.publications.initializePublicationSteps(
      runId,
      token as string,
      ['issue:summary-comment']
    )
    await store.publications.requirePublicationStepClaim(
      runId,
      token as string,
      'issue:summary-comment'
    )
    // The shape disconnection exists for: the step may have taken effect remotely and nobody can
    // establish whether it did. Attempts and reconciliations keep failing until the store moves
    // the step to `uncertain`; every further reconciliation fails here (the remote check throws).
    const stepStatus = async (): Promise<string> =>
      (
        (await store.publications.listPublicationSteps(runId))[0] as {
          status: string
        }
      ).status
    // Whether a claim succeeds or reports the budget spent is the budget's decision, not the
    // test's: both mean the reconciliation budget below is what matters.
    const claim = async (): Promise<void> => {
      await store.publications
        .requirePublicationStepClaim(
          runId,
          token as string,
          'issue:summary-comment'
        )
        .catch(() => undefined)
    }
    const reconcile = async (): Promise<void> => {
      await store.publications.failPublicationStep(
        runId,
        token as string,
        'issue:summary-comment',
        { code: 'GITHUB_TIMEOUT', message: 'provider did not answer' },
        { retry: true }
      )
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await reconcile()
      await claim()
    }
    // Reconciliation after reconciliation never reaches an answer, until the budget parks it.
    for (
      let attempt = 0;
      attempt < 10 && (await stepStatus()) !== 'disconnected';
      attempt += 1
    ) {
      await reconcile()
    }
    const parkedStep = (
      await store.publications.listPublicationSteps(runId)
    )[0] as {
      status: string
    }
    assert.strictEqual(parkedStep.status, 'disconnected')
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'disconnected',
      'the axis reports the step uncertainty so the run surfaces for an operator'
    )
    const attention = await store.notices.claimNext()
    assert.ok(attention)
    assert.strictEqual(attention.run_id, runId)
    assert.strictEqual(attention.axis, 'publication')
    assert.strictEqual(attention.kind, 'attention')
    // Automation must not pick it up: no selector claims a run whose step is parked, and the
    // internal single-run claim refuses it too. Without a way out, the run would be stuck with
    // no owner and no writer - which is exactly why the operator resume exists.
    assert.strictEqual(await store.publicationClaims.claim(runId), null)

    // The operator resume hands the parked work back to automatic recovery, which is what the
    // contract promises ("published again"): the parked step becomes attemptable again and both
    // budgets are refreshed. It is the operator's decision that unparks a side effect whose
    // outcome nobody established - automation never does this on its own - and it is recorded as
    // its own event. `recovery_attempt_count` is internal (the summary deliberately does not
    // publish it), so the budgets are read from the row that actually holds them.
    const readStep = async (): Promise<{
      status: string
      attempt_count: number
      recovery_attempt_count: number
    }> =>
      (
        await pool.query<{
          status: string
          attempt_count: number
          recovery_attempt_count: number
        }>(
          `SELECT status,attempt_count,recovery_attempt_count FROM publication_steps
           WHERE run_id=$1`,
          [runId]
        )
      ).rows[0] as {
        status: string
        attempt_count: number
        recovery_attempt_count: number
      }
    const resumed = await store.operatorDecisions.resumeDisconnectedRun(runId)
    assert.strictEqual(
      resumed.publication.status,
      'pending',
      'the axis is immediately claimable by the normal publisher'
    )
    const superseded = await pool.query<{
      status: string
      claim_token: string | null
      claimed_at: string | null
    }>(
      `SELECT status,claim_token,claimed_at FROM run_notices
       WHERE notice_id=$1 AND run_id=$2`,
      [attention.notice_id, runId]
    )
    assert.deepStrictEqual(superseded.rows[0], {
      status: 'superseded',
      claim_token: null,
      claimed_at: null
    })
    assert.strictEqual(
      await store.notices.renewClaim(
        attention.notice_id,
        attention.claim_token
      ),
      false
    )
    const revived = await readStep()
    assert.strictEqual(
      revived.status,
      'pending',
      'the parked step is attemptable again, not merely reconcilable'
    )
    assert.strictEqual(
      revived.recovery_attempt_count,
      0,
      'the operator decision refreshes the reconciliation budget'
    )
    assert.strictEqual(
      revived.attempt_count,
      0,
      'and the attempt budget, so the side effect can be published again'
    )

    // The resumed run publishes instead of only looking: the claim its spent budget refused is
    // granted now, which is the difference between "published again" and "keep publishing".
    const resumedToken = await store.publicationClaims.claim(runId)
    assert.ok(resumedToken)
    await store.publications.requirePublicationStepClaim(
      runId,
      resumedToken,
      'issue:summary-comment'
    )
    assert.strictEqual(await readStep().then((step) => step.status), 'running')

    // The resume is on the record.
    const events = await store.queries.listEvents(runId)
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'publication' &&
          event.to_status === 'pending' &&
          event.reason_code === 'PUBLICATION_RESUMED_BY_OPERATOR'
      )
    )

    // The resumed attempt finishes the way a first attempt would: recording its result ends the
    // step and lets the publication conclude, so a resumed run reaches a real outcome rather
    // than stopping at reconciliation.
    assert.strictEqual(
      await store.publications.completePublicationStep(
        runId,
        resumedToken,
        'issue:summary-comment',
        { id: '7', url: 'https://example.test/c/7' }
      ),
      true
    )
    assert.strictEqual(
      await store.publications.complete(runId, resumedToken),
      true
    )
    assert.strictEqual(
      (await store.queries.getRun(runId))?.publication.status,
      'published',
      'the resumed publication finishes'
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('a takeover must re-derive the exact step set its predecessor stored', async () => {
  // The publish paths recompute their step keys on every attempt and pass them to
  // initializePublicationSteps, which rejects any set that differs from the stored one with a
  // *terminal* code. A run whose publisher died while its steps were uncertain is taken over and
  // enters that same path again, so a takeover must be able to re-derive what was written. If it
  // cannot, the publication fails its own retry and neither resume nor give-up can recover it.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(token, null)
    await store.publications.initializePublicationSteps(
      runId,
      token as string,
      ['issue:draft-pr', 'issue:summary-comment']
    )

    // The publisher's lease expires while its steps are uncertain, and another owner claims the
    // publication. This is the ordinary takeover path, not an operator resume.
    await pool.query(
      `UPDATE publications SET claimed_at=clock_timestamp()-($2*interval '1 millisecond')
       WHERE run_id=$1`,
      [runId, 600_000]
    )
    const takeover = await store.publicationClaims.claim(runId)
    assert.notStrictEqual(takeover, null, 'an expired lease is taken over')

    // The new owner re-runs the same derivation its predecessor did.
    await store.publications.initializePublicationSteps(
      runId,
      takeover as string,
      ['issue:draft-pr', 'issue:summary-comment']
    )

    // Omitting an existing step is a contract change, not compatibility. Accepting it would leave
    // stored work that this publisher never attempts and make completion impossible.
    await assert.rejects(
      store.publications.initializePublicationSteps(runId, takeover as string, [
        'issue:summary-comment'
      ]),
      (error: unknown) => {
        assert.strictEqual(
          (error as { code?: string }).code,
          'PUBLICATION_STEP_SET_CHANGED'
        )
        return true
      }
    )
  } finally {
    await pool.end()
    await store.close()
  }
})

test('abandoning a run that is no longer disconnected answers 409, not an opaque fault', async () => {
  // The endpoint only ever concludes a run that is still waiting on an operator. When the row
  // has moved on, the request names a run in a state this operation may not act on: that is a
  // client-visible conflict rather than the opaque 500 a bare Error becomes.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const runId = `run-${randomUUID()}`
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    // The row is concluded elsewhere while the operator is looking at it. The endpoint must then
    // answer 409 rather than act on a run that is no longer disconnected.
    await pool.query(
      `UPDATE preparations SET status='failed', claim_token=NULL, claimed_at=NULL,
         started_at=clock_timestamp(), finished_at=clock_timestamp(),
         disconnect_reason=NULL
       WHERE run_id=$1`,
      [runId]
    )
    await assert.rejects(
      store.operatorDecisions.abandonBlockedPreparation(
        runId,
        'operator decision'
      ),
      (error: unknown) => {
        assert.strictEqual(
          (error as { statusCode?: number }).statusCode,
          409,
          'a contradiction the endpoint cannot act on is a client-visible conflict'
        )
        return true
      }
    )
    // Nothing was written on the refused path.
    const stored = await pool.query<{ status: string; reason: string | null }>(
      'SELECT status, disconnect_reason AS reason FROM preparations WHERE run_id=$1',
      [runId]
    )
    assert.deepStrictEqual(stored.rows[0], {
      status: 'failed',
      reason: null
    })
  } finally {
    await pool.end()
    await store.close()
  }
})

test('an execution failure and an in-flight step commit converge on one outcome', async () => {
  // A publisher can be committing a step while coordination concludes the run's execution.
  // Either order is legitimate: the step may finish first and then be abandoned with the
  // publication, or the failure may converge the publication first and refuse the commit. What
  // must never happen is a step recorded `succeeded` on a publication that was already
  // concluded, or a publication left `publishing` with nobody able to finish it.
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    for (const executorFirst of [true, false]) {
      const store = await createStore()
      const runId = await createQueuedRun(store)
      try {
        // Model a publisher that started before the outcome was rewritten: `claimPublication`
        // requires a successful execution, so the in-flight row is created directly.
        const token = randomUUID()
        await pool.query(
          `INSERT INTO publication_steps (connector_id,run_id,step_key,status,claimed_by)
           VALUES ($1,$2,'step','running',$3)`,
          [store.connectorId, runId, token]
        )
        await pool.query(
          `UPDATE publications SET status='publishing', claim_token=$2,
             claimed_at=clock_timestamp(), started_at=clock_timestamp()
           WHERE run_id=$1`,
          [runId, token]
        )

        const complete = async (): Promise<boolean> =>
          await store.publications.completePublicationStep(
            runId,
            token,
            'step',
            {
              url: 'https://example.test/comment'
            }
          )
        const failExecution = async (): Promise<boolean> =>
          await store.failExecution(runId, {
            code: 'EXECUTION_FAILED',
            message: 'execution concluded the task failed'
          })

        if (executorFirst) {
          await failExecution()
          assert.strictEqual(
            await complete(),
            false,
            'a step commit after the publication was abandoned is refused'
          )
        } else {
          assert.strictEqual(await complete(), true)
          await failExecution()
        }

        const stored = await store.queries.getRun(runId)
        assert.strictEqual(
          stored?.execution.status,
          'failed',
          'the execution conclusion is the run outcome in both orders'
        )
        assert.strictEqual(
          stored?.publication.status,
          'skipped',
          'a publication whose execution failed is never left publishing'
        )
        const steps = await store.publications.listPublicationSteps(runId)
        assert.strictEqual(
          steps[0]?.status,
          executorFirst ? 'running' : 'succeeded',
          'the step records whether its side effect had already been committed'
        )
        // Whatever the order produced, a further commit can no longer attach to the run.
        assert.strictEqual(
          await complete(),
          false,
          'a step commit after the run concluded is refused, not recorded'
        )
      } finally {
        await store.close()
      }
    }
  } finally {
    await pool.end()
  }
})

test('a step claim is refused once another path has concluded the publication', async () => {
  // `claimPublicationStep` used to be a single UPDATE whose WHERE read `publications`, which
  // takes a snapshot: a concurrent path that moved the publication to `skipped` could commit in
  // between, and the step would still be claimed `running` on a concluded publication. The
  // claim now locks the publication row first, so it either observes the conclusion or the
  // conclusion waits for it - never a `running` step left behind.
  const store = await createStore()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  const blocker = await pool.connect()
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, ['s'])

    // A separate transaction concludes the publication without committing yet. The claim must
    // wait for it rather than read the pre-conclusion snapshot.
    await blocker.query('BEGIN')
    await blocker.query(
      `UPDATE publications SET status='skipped', claim_token=NULL, claimed_at=NULL,
         finished_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2`,
      [runId, store.connectorId]
    )
    const claim = store.publications.requirePublicationStepClaim(
      runId,
      token,
      's'
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await blocker.query('COMMIT')

    await assert.rejects(
      claim,
      /not claimable/,
      'a claim against a publication concluded by another path is refused'
    )
    const steps = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(
      steps[0]?.status,
      'pending',
      'the refused claim must not leave a running step behind'
    )
  } finally {
    blocker.release()
    await pool.end()
    await store.close()
  }
})

test('a step failure records its code and message on the right fields', async () => {
  // `failPublicationStep` binds five positional values, two of them connector-supplied strings
  // (`error.code` and `error.message`). A reordering that swapped those two would still pass a
  // test that only checked the step left `running`, so this pins the actual fields rather than
  // the write happening at all.
  const store = await createStore()
  try {
    const runId = await createSuccessfulRun(store)
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, ['s'])
    await store.publications.requirePublicationStepClaim(runId, token, 's')
    assert.strictEqual(
      await store.publications.failPublicationStep(
        runId,
        token,
        's',
        { code: 'SOME_CODE', message: 'some message' },
        { retry: true }
      ),
      true
    )
    const [step] = await store.publications.listPublicationSteps(runId)
    assert.deepStrictEqual(
      {
        status: step?.status,
        code: step?.failure_code,
        message: step?.failure_message,
        attempt_count: step?.attempt_count
      },
      {
        status: 'failed',
        code: 'SOME_CODE',
        message: 'some message',
        attempt_count: 1
      },
      'the code and message must land in their own columns, not each other'
    )
  } finally {
    await store.close()
  }
})

test('an owner cannot claim a publication step it already holds', async () => {
  // A step left `running` may belong to a publisher that died mid-effect, so a *different*
  // publication token must be able to take it over. The same token must not: it would start a
  // second attempt for one side effect, inflating the attempt count that reconciliation reads to
  // decide whether an earlier owner already ran. Before `claimed_by` existed the two cases were
  // indistinguishable, and claiming twice under one token silently incremented the count.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, ['s'])

    await store.publications.requirePublicationStepClaim(runId, token, 's')
    assert.strictEqual(
      (await store.publications.listPublicationSteps(runId))[0]?.attempt_count,
      1
    )
    await assert.rejects(
      store.publications.requirePublicationStepClaim(runId, token, 's'),
      /not claimable/,
      'the holder must not start a second attempt on its own running step'
    )
    assert.strictEqual(
      (await store.publications.listPublicationSteps(runId))[0]?.attempt_count,
      1,
      'the refused claim must not touch the attempt count'
    )
  } finally {
    await store.close()
  }
})

test('an uncertain submission queues no notice until the run is conclusively failed', async () => {
  // Entering `uncertain` means the outcome is unknown, so a notice there would tell the requester
  // "this never started" while a replay may still be accepted and the review may complete and
  // publish normally. A posted comment cannot be taken back, so the notice waits for the
  // transition that actually concludes the run.
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-uncertain-notice-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await store.submissionTransitions.savePreparedSubmission(
      runId,
      admission.preparation_token as string,
      {},
      await publishedInput(
        store,
        runId,
        admission.preparation_token as string,
        { api_version: 'v1' }
      )
    )
    await store.preparations.fail(
      runId,
      admission.preparation_token as string,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' },
      { retry: false }
    )

    const uncertain = await store.queries.getRun(runId)
    assert.strictEqual(uncertain?.execution.status, 'uncertain')
    assert.deepStrictEqual(
      uncertain?.notices,
      [],
      'an unknown outcome must not be announced as a failure'
    )
    assert.strictEqual(
      await store.notices.claimNext(),
      null,
      'nothing may be deliverable while the run can still succeed'
    )

    // The replay is accepted: the run proceeds normally and was never announced as failed.
    const recoveryToken = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(recoveryToken)
    assert.strictEqual(
      await store.submissionTransitions.completeSubmissionRecovery(
        runId,
        recoveryToken
      ),
      true
    )
    const recovered = await store.queries.getRun(runId)
    assert.strictEqual(recovered?.execution.status, 'queued')
    assert.deepStrictEqual(
      recovered?.notices,
      [],
      'a recovered run must not carry a failure notice'
    )
    assert.strictEqual(await store.notices.claimNext(), null)
  } finally {
    await store.close()
  }
})

test('a rejected replay announces the failure that actually happened', async () => {
  // The notice belongs to the path that concludes the run, not to the one that merely loses track
  // of it. This is the write that makes the eventual comment describe a real failure.
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-rejected-replay-notice-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await store.submissionTransitions.savePreparedSubmission(
      runId,
      admission.preparation_token as string,
      {},
      await publishedInput(
        store,
        runId,
        admission.preparation_token as string,
        { api_version: 'v1' }
      )
    )
    await store.preparations.fail(
      runId,
      admission.preparation_token as string,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' },
      { retry: false }
    )
    const recoveryToken = await store.executions.claimSubmissionRecovery(runId)
    assert.ok(recoveryToken)
    assert.strictEqual(
      await store.submissionTransitions.failSubmissionRecovery(
        runId,
        recoveryToken,
        {
          code: 'EXECUTION_REJECTED',
          message: 'the Execution refused the replayed submission'
        }
      ),
      true
    )

    const run = await store.queries.getRun(runId)
    assert.strictEqual(run?.execution.status, 'failed')
    assert.strictEqual(run?.publication.status, 'skipped')
    assert.deepStrictEqual(run?.notices, [
      {
        notice_id: run?.notices[0]?.notice_id,
        kind: 'failure',
        axis: 'execution',
        status: 'pending',
        reason_code: 'EXECUTION_REJECTED',
        comment_url: null
      }
    ])
  } finally {
    await store.close()
  }
})

test('an uncertain submission that never resolves is concluded once its budget is spent', async () => {
  // Without a budget this run would stay `uncertain` forever, and (now that entering that state
  // queues no notice) would never be reported at all. Spending the budget concludes it as a real
  // failure, which is what makes the notice truthful.
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-recovery-exhausted-${randomUUID()}`
  try {
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await store.submissionTransitions.savePreparedSubmission(
      runId,
      admission.preparation_token as string,
      {},
      await publishedInput(
        store,
        runId,
        admission.preparation_token as string,
        { api_version: 'v1' }
      )
    )
    await store.preparations.fail(
      runId,
      admission.preparation_token as string,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' },
      { retry: false }
    )

    const recovering = await store.queries.getRun(runId)
    assert.ok(recovering)
    assert.strictEqual(
      await concludeExhaustedSubmissionRecovery(store, recovering),
      null,
      'an unspent budget must leave the run to the normal replay path'
    )

    // Every replay keeps ending with an unknown outcome.
    for (
      let attempt = 0;
      attempt < MAX_SUBMISSION_RECOVERY_ATTEMPTS;
      attempt += 1
    ) {
      const claimed = await store.executions.claimSubmissionRecovery(runId)
      assert.ok(claimed, `replay ${attempt + 1} should be claimable`)
      assert.strictEqual(
        await store.executions.recordUnknownRecoveryOutcome(runId, claimed),
        true
      )
    }
    assert.strictEqual(
      await store.executions.submissionRecoveryAttemptCount(runId),
      MAX_SUBMISSION_RECOVERY_ATTEMPTS
    )
    assert.deepStrictEqual(
      (await store.queries.getRun(runId))?.notices,
      [],
      'replaying an unknown outcome is not yet a conclusion'
    )

    const exhaustedRun = await store.queries.getRun(runId)
    assert.ok(exhaustedRun)
    assert.deepStrictEqual(
      await concludeExhaustedSubmissionRecovery(store, exhaustedRun),
      { status: 'disconnected' }
    )
    const run = await store.queries.getRun(runId)
    assert.strictEqual(run?.execution.status, 'disconnected')
    assert.strictEqual(run?.failure_code, 'SUBMISSION_STATE_UNCERTAIN')
    assert.strictEqual(run?.publication.status, 'pending')
    assert.deepStrictEqual(run?.notices, [
      {
        notice_id: run?.notices[0]?.notice_id,
        kind: 'attention',
        axis: 'execution',
        status: 'pending',
        reason_code: 'SUBMISSION_RECOVERY_EXHAUSTED',
        comment_url: null
      }
    ])
    // The budget is spent, so a later pass does not replay this run again.
    assert.strictEqual(
      await store.executions.claimSubmissionRecovery(runId),
      null
    )
  } finally {
    await store.close()
  }
})

test('a step whose owners kept dying exhausts the budget and is concluded', async () => {
  // The budget is spent by attempts, not by recorded failures. A publisher that dies mid-effect
  // never calls `failPublicationStep`, so a failure-only budget would let this step be taken over
  // forever: every new owner would start another attempt, die, and leave the run `publishing`
  // with nobody to finish it. Counting the attempt makes the crash loop end the same way a
  // failure loop does, and the takeover that finds no budget left is what concludes the step.
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = await createSuccessfulRun(store)
  try {
    const first = await store.publicationClaims.claim(runId)
    assert.ok(first)
    await store.publications.initializePublicationSteps(runId, first, ['s'])
    await store.publications.requirePublicationStepClaim(runId, first, 's')

    // Attempts 2 and 3 are taken over by new owners that also die without reporting.
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const takeover = await store.publicationClaims.claim(runId)
      assert.ok(
        takeover,
        `attempt ${attempt} should claim a new publication owner`
      )
      await store.publications.requirePublicationStepClaim(runId, takeover, 's')
      assert.strictEqual(
        (await store.publications.listPublicationSteps(runId))[0]
          ?.attempt_count,
        attempt
      )
    }
    assert.strictEqual(
      (await store.publications.listPublicationSteps(runId))[0]?.status,
      'running',
      'no failure was ever recorded, yet the budget is spent'
    )

    const last = await store.publicationClaims.claim(runId)
    assert.ok(last)
    await assert.rejects(
      store.publications.requirePublicationStepClaim(runId, last, 's'),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_RETRY_EXHAUSTED'
    )
    // Now `uncertain`, not concluded: every one of those owners may have finished the side
    // effect before dying, so the step must be reconciled rather than declared failed.
    const [exhausted] = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(exhausted?.status, 'uncertain')
    assert.strictEqual(exhausted?.attempt_count, 3)

    // Only a reconciliation that confirms absence concludes it, and it releases the claim: a
    // concluded row that still names an owner would read as work someone is holding.
    assert.strictEqual(
      await store.publications.settleExhaustedPublicationStep(
        runId,
        last,
        's',
        {
          found: false
        }
      ),
      true
    )
    const [step] = await store.publications.listPublicationSteps(runId)
    assert.strictEqual(step?.status, 'terminal_failed')
    assert.strictEqual(step?.attempt_count, 3)
    const observer = new Pool({ connectionString: requireTestDatabase() })
    try {
      const owner = await observer.query<{ claimed_by: string | null }>(
        `SELECT claimed_by FROM publication_steps WHERE run_id=$1`,
        [runId]
      )
      assert.strictEqual(owner.rows[0]?.claimed_by, null)
    } finally {
      await observer.end()
    }
  } finally {
    await store.close()
  }
})
