// Exercises the PostgreSQL-backed coordination state machines, including their
// claim fencing and cross-connector ownership rules.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

import {
  coordinateReviewRunsOnce,
  recoverReviewRunSubmission,
  ReviewRunStore,
  submitPreparedRun,
  type RunnerArtifactStorage
} from '../../src/index.js'
import { RunnerSubmissionUncertainError } from '../../src/runner-client.js'

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

async function createQueuedRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  const context = {}
  const admission = await store.createPreparingReviewRun({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.markQueued(runId, admission.preparation_token, context)
  return runId
}

async function createSuccessfulRun(
  store: ReviewRunStore,
  runId = `run-${randomUUID()}`
): Promise<string> {
  await createQueuedRun(store, runId)
  assert.strictEqual(
    await store.recordRunnerSuccess(
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

    assert.strictEqual((await first.getRun(runId))?.run_id, runId)
    // run_id is currently a global primary key, while connector_id fences
    // reads and claims. A second connector must not create or see the first
    // connector's run under that identity.
    await assert.rejects(
      createQueuedRun(second, runId),
      /duplicate key value violates unique constraint/
    )
    assert.strictEqual(await second.getRun(runId), null)
    assert.strictEqual((await first.listActiveRuns()).runs.length, 1)
    assert.strictEqual((await second.listActiveRuns()).runs.length, 0)
    assert.strictEqual(await first.claimPublication(runId), null)
    await first.recordRunnerSuccess(
      runId,
      { run_id: runId },
      { status: 'unavailable' }
    )
    assert.notStrictEqual(await first.claimPublication(runId), null)
    assert.strictEqual(await second.claimPublication(runId), null)
    // The event log is fenced by the same connector as every other read. A second connector
    // reading the identity it cannot own must get an empty list, not another tenant's
    // transitions, so the history view can never cross a connector boundary.
    assert.ok((await first.listEvents(runId)).length > 0)
    assert.deepStrictEqual(await second.listEvents(runId), [])
  } finally {
    await first.close()
    await second.close()
  }
})

test('ReviewRunStore persists queued runs and keeps preparing runs out of polling', async () => {
  const store = await createStore()
  try {
    const queuedId = await createQueuedRun(store)
    const artifactStorage: RunnerArtifactStorage = {
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: `s3://sec-review/runs/${queuedId}/artifacts/diagnostic-tree.v1.tar.zst`,
        media_type: 'application/tar+zstd',
        digest: `sha256:${'a'.repeat(64)}`,
        size_bytes: 123
      }
    }
    await store.recordArtifactStorage(queuedId, artifactStorage)
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const queued = await store.getRun(queuedId)
    assert.strictEqual(queued?.execution.status, 'queued')
    assert.deepStrictEqual(queued?.artifact_storage, artifactStorage)
    assert.deepStrictEqual(
      (await store.listActiveRuns()).runs.map((entry) => entry.run_id),
      [queuedId]
    )
  } finally {
    await store.close()
  }
})

test('execution.started_at marks the instant execution began and does not move afterwards', async () => {
  const store = await createStore()
  try {
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const runId = admission.record.run_id
    assert.ok(admission.preparation_token)

    // Before submission the run is still preparing: there is no execution start to report.
    assert.strictEqual((await store.getRun(runId))?.execution.started_at, null)

    await store.markQueued(runId, admission.preparation_token, {})
    const queued = await store.getRun(runId)
    assert.ok(queued?.execution.started_at)
    const submittedAt = queued?.execution.started_at

    // A later, non-transitional write (the artifact mtime) must not move the start.
    await store.recordArtifactStorage(runId, { status: 'unavailable' })
    const after = await store.getRun(runId)
    assert.strictEqual(after?.execution.started_at, submittedAt)
    assert.ok(
      Date.parse(after!.execution.updated_at) >= Date.parse(submittedAt!),
      'the row mtime moves past the immutable execution start'
    )
  } finally {
    await store.close()
  }
})

test('runner termination events name the state they came from', async () => {
  const store = await createStore()
  try {
    // running -> succeeded must record from_status 'running', not null. `null` is reserved for
    // the first event on an axis, so a null here would make the timeline claim the run started
    // at that point.
    const succeededId = await createQueuedRun(store)
    await store.markRunning(succeededId)
    assert.strictEqual(
      await store.recordRunnerSuccess(
        succeededId,
        { run_id: succeededId },
        undefined
      ),
      true
    )
    const succeededEvents = (await store.listEvents(succeededId)).filter(
      (event) => event.axis === 'execution'
    )
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
      await store.failRunnerExecution(failedId, {
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'boom'
      }),
      true
    )
    const failedEvents = (await store.listEvents(failedId)).filter(
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
    // At least the admission (runner pending, preparation preparing, publication pending)
    // and the pending->queued + preparing->submitted transitions must be present.
    const events = await store.listEvents(runId)
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
    const before = await store.getRun(runId)
    assert.strictEqual(before?.execution.status, 'queued')
    // The heartbeat must move the mtime forward even though the status is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.touchObservation(runId)
    const after = await store.getRun(runId)
    assert.strictEqual(after?.execution.status, 'queued', 'state is unchanged')
    assert.ok(
      Date.parse(after!.execution.updated_at) >
        Date.parse(before!.execution.updated_at),
      'the row mtime moved forward'
    )
    // It must not touch a run that is not being polled.
    const admitted = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const preparingBefore = admitted.record.execution.updated_at
    await store.touchObservation(admitted.record.run_id)
    assert.strictEqual(
      (await store.getRun(admitted.record.run_id))?.execution.updated_at,
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
    const admission = await store.createPreparingReviewRun({
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
          input: {}
        },
        async () => {
          throw new RunnerSubmissionUncertainError('response lost')
        }
      ),
      RunnerSubmissionUncertainError
    )
    const first = await store.claimSubmissionRecovery(runId)
    assert.ok(first)

    // Heartbeat repeatedly past the 300ms lease. If the lease were observed_at-based, these
    // heartbeats would keep the claim alive and the reclaim below would return null.
    const deadline = Date.now() + 600
    while (Date.now() < deadline) {
      await store.touchObservation(runId)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const second = await store.claimSubmissionRecovery(runId)
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
    const admission = await store.createPreparingReviewRun({
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
          input: {}
        },
        async () => {
          throw new RunnerSubmissionUncertainError('response lost')
        }
      ),
      RunnerSubmissionUncertainError
    )
    assert.strictEqual(
      (await store.getRun(runId))?.execution.status,
      'uncertain'
    )

    const first = await store.claimSubmissionRecovery(runId)
    assert.ok(first)
    // Heartbeats would, under a shared updated_at lease, refresh the recovery lease. With
    // observed_at separate they must not; a zero timeout lets us observe that directly.
    await store.touchObservation(runId)
    const second = await store.claimSubmissionRecovery(runId)
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'REVIEW_START_FAILED',
      message: 'preparation could not start'
    })
    const notice = await store.claimNextRunFailureNotice()
    assert.ok(notice)
    assert.strictEqual(notice.failure_code, 'REVIEW_START_FAILED')

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
    const stillReported = await store.getRun(runId)
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
        `UPDATE run_failure_notices
           SET status='pending', claim_token=NULL, claimed_at=NULL WHERE run_id=$1`,
        [runId]
      )
    } finally {
      await pool2.end()
    }
    const reclaimed = await store.claimNextRunFailureNotice()
    assert.ok(reclaimed)
    assert.strictEqual(
      reclaimed.failure_code,
      'REVIEW_START_FAILED',
      "the notice carries its own reason, not the preparation row's current value"
    )
  } finally {
    await store.close()
  }
})

test('ReviewRunStore returns an expired preparation to pending without failing its run', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-stale-preparation-${randomUUID()}`
  try {
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })

    assert.strictEqual((await store.expireStalePreparations()).concluded, 1)
    const run = await store.getRun(runId)
    assert.strictEqual(run?.execution.status, 'pending')
    assert.strictEqual(run?.failure_code, null)
    assert.strictEqual(run?.preparation?.status, 'pending')
    assert.strictEqual(run?.preparation?.attempt_count, 1)
    assert.strictEqual(run?.failure_notice, null)
    assert.strictEqual(await store.claimPublication(runId), null)
    assert.strictEqual((await store.expireStalePreparations()).concluded, 0)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore exhausts a preparation whose final claim lease expires', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-exhausted-preparation-${randomUUID()}`
  try {
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await observer.query(
      `UPDATE preparations SET attempt_count=8,
        claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual((await store.expireStalePreparations()).concluded, 1)
    const run = await store.getRun(runId)
    assert.strictEqual(run?.execution.status, 'skipped')
    assert.strictEqual(run?.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.deepStrictEqual(
      {
        status: run?.preparation?.status,
        attempt_count: run?.preparation?.attempt_count,
        failure_code: run?.preparation?.failure_code,
        notice_status: run?.failure_notice?.status,
        notice_stage: run?.failure_notice?.failure_stage
      },
      {
        status: 'failed',
        attempt_count: 8,
        failure_code: 'PREPARATION_RETRY_EXHAUSTED',
        notice_status: 'pending',
        notice_stage: 'preparation'
      }
    )
    assert.strictEqual(await store.claimNextPreparation(), null)
    assert.strictEqual(await store.claimPublication(runId), null)
    const notice = await store.claimNextRunFailureNotice()
    assert.ok(notice)
    assert.strictEqual(notice.run_id, runId)
    assert.deepStrictEqual(notice.input, {})
    assert.strictEqual(notice.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.strictEqual(
      (await store.getRun(runId))?.failure_notice?.status,
      'delivering'
    )
    assert.strictEqual(
      // A stale claim is rejected, not thrown at: the delivery is well-formed, it simply no
      // longer owns the notice.
      await store.completeRunFailureNotice(
        runId,
        randomUUID(),
        true,
        'https://github.com/example/example/issues/1#issuecomment-1'
      ),
      false
    )
    assert.strictEqual(
      await store.completeRunFailureNotice(
        runId,
        notice.claim_token,
        true,
        'https://github.com/example/example/issues/1#issuecomment-1'
      ),
      true
    )
    assert.strictEqual(
      (await store.getRun(runId))?.failure_notice?.status,
      'delivered'
    )
    assert.strictEqual(await store.claimNextRunFailureNotice(), null)
  } finally {
    await observer.end()
    await store.close()
  }
})

test('re-claiming an expired notice records delivering -> delivering, not pending -> delivering', async () => {
  const connector = `notice-lease:${randomUUID()}`
  const store = await createStore({ connectorId: connector, claimTimeoutMs: 0 })
  const observer = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-notice-lease-${randomUUID()}`
  try {
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    // Produce a terminal preparation failure so a notice exists.
    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour',
         attempt_count=8 WHERE run_id=$1`,
      [runId]
    )
    await store.expireStalePreparations()

    const first = await store.claimNextRunFailureNotice()
    assert.ok(first)
    // Expire its lease, then claim again: the notice was already `delivering`.
    await observer.query(
      `UPDATE run_failure_notices SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    const second = await store.claimNextRunFailureNotice()
    assert.ok(second)

    const noticeEvents = (await store.listEvents(runId)).filter(
      (event) => event.axis === 'notice'
    )
    assert.deepStrictEqual(
      noticeEvents.map((event) => [event.from_status, event.to_status]),
      [
        [null, 'pending'],
        ['pending', 'delivering'],
        ['delivering', 'delivering']
      ],
      'the re-claim comes from delivering, and is marked as a lease expiry'
    )
    assert.strictEqual(noticeEvents[2]?.reason_code, 'NOTICE_LEASE_EXPIRED')
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
    await producer.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    await observer.query(
      `UPDATE preparations SET attempt_count=8,
        claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual((await producer.expireStalePreparations()).concluded, 1)

    const claims = await Promise.all([
      first.claimNextRunFailureNotice(),
      second.claimNextRunFailureNotice()
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {},
      preparation_input_version: 'v1',
      preparation_input: { kind: 'connector_issue_review', issue_number: 12 }
    })
    assert.ok(admission.preparation_token)
    await store.checkpointPreparationInput(runId, admission.preparation_token, {
      kind: 'connector_issue_review',
      issue_number: 12,
      resolved: true
    })
    assert.strictEqual((await store.expireStalePreparations()).concluded, 1)

    const claimed = await store.claimNextPreparation()
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
      await store.renewPreparationClaim(runId, admission.preparation_token),
      false
    )
    assert.strictEqual(await store.renewPreparationClaim(runId, token), true)
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
    const admission = await first.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: `run-concurrent-preparation-${randomUUID()}`,
      publish_context: {},
      preparation_input_version: 'v1',
      preparation_input: { kind: 'connector_issue_review' }
    })
    assert.ok(admission.preparation_token)
    assert.strictEqual((await first.expireStalePreparations()).concluded, 1)

    const claims = await Promise.all([
      first.claimNextPreparation(),
      second.claimNextPreparation()
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
    const admission = await store.admitReviewRun({
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
      await store.failPreparation(
        runId,
        admission.preparation_token,
        { message: 'temporary' },
        { retry: true, retryAfterMs: 60_000 }
      ),
      { retry_scheduled: true }
    )
    const replay = await store.admitReviewRun({
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
    assert.strictEqual(await store.claimNextPreparation(), null)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore renews only the current preparation owner', async () => {
  const store = await createStore({ claimTimeoutMs: 1_000 })
  const runId = `run-renewed-preparation-${randomUUID()}`
  const observer = new Pool({ connectionString: requireTestDatabase() })
  try {
    assert.strictEqual(store.preparationHeartbeatIntervalMs(), 333)
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )

    assert.strictEqual(
      await store.renewPreparationClaim(runId, admission.preparation_token),
      true
    )
    assert.strictEqual(
      await store.renewPreparationClaim(runId, randomUUID()),
      false
    )
    assert.strictEqual((await store.expireStalePreparations()).concluded, 0)

    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual((await store.expireStalePreparations()).concluded, 1)
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
    const admission = await store.admitReviewRun({
      workflow: 'pull-request-review',
      run_id: runId,
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: ingressKey
    })
    assert.ok(admission.preparation_token)

    // Input preparation happens after durable admission. Its failure must keep
    // the original run and ingress identity available for diagnosis/replay.
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'REVIEW_START_FAILED',
      message: 'input bundle upload failed'
    })

    const failed = await store.getRun(runId)
    assert.strictEqual(failed?.execution.status, 'skipped')
    assert.strictEqual(failed?.ingress_kind, 'github_webhook')
    assert.strictEqual(failed?.ingress_key, ingressKey)
    assert.strictEqual(failed?.failure_code, 'REVIEW_START_FAILED')
    assert.strictEqual(failed?.failure_message, 'input bundle upload failed')
    assert.deepStrictEqual((await store.listActiveRuns()).runs, [])
    assert.strictEqual(await store.claimPublication(runId), null)

    const replay = await store.admitReviewRun({
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
  await first.createPreparingReviewRun({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: {}
  })
  await first.close()

  const restarted = await createStore({ connectorId: sharedConnector })
  try {
    const record = await restarted.getRun(runId)
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
      first.admitReviewRun({ ...ingress, run_id: `run-${randomUUID()}` }),
      second.admitReviewRun({ ...ingress, run_id: `run-${randomUUID()}` })
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
    const first = await ownerA.admitReviewRun({
      ...ingress,
      run_id: `run-${randomUUID()}`
    })
    const replay = await ownerB.admitReviewRun({
      ...ingress,
      run_id: `run-${randomUUID()}`
    })
    assert.ok(first.preparation_token)
    assert.strictEqual(replay.created, false)
    assert.strictEqual(replay.preparation_token, null)
    assert.strictEqual(replay.record.run_id, first.record.run_id)

    assert.strictEqual((await ownerB.expireStalePreparations()).concluded, 1)
    const takeover = await ownerB.claimNextPreparation()
    assert.ok(takeover)
    assert.strictEqual(takeover.run_id, first.record.run_id)
    assert.notStrictEqual(takeover.claim_token, first.preparation_token)

    await assert.rejects(
      ownerA.checkpointPreparationInput(
        first.record.run_id,
        first.preparation_token,
        { stale: true }
      ),
      /claim was lost before checkpointing input/
    )
    await assert.rejects(
      ownerA.savePreparedSubmission(
        first.record.run_id,
        first.preparation_token,
        {},
        {}
      ),
      /cannot save prepared submission/
    )
    await assert.rejects(
      ownerA.markQueued(first.record.run_id, first.preparation_token, {}),
      /cannot transition/
    )
    await assert.rejects(
      ownerA.failPreparation(first.record.run_id, first.preparation_token, {
        message: 'late failure'
      }),
      /lost its claim/
    )
    await ownerB.markQueued(takeover.run_id, takeover.claim_token, {})
    assert.strictEqual(
      (await ownerA.getRun(first.record.run_id))?.execution.status,
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.savePreparedSubmission(
      runId,
      admission.preparation_token,
      {},
      { contract_version: 'v6' }
    )
    await store.failPreparation(runId, admission.preparation_token, {
      code: 'SUBMISSION_STATE_UNCERTAIN',
      message: 'response lost'
    })
    const staleToken = await store.claimSubmissionRecovery(runId)
    const currentToken = await store.claimSubmissionRecovery(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notStrictEqual(staleToken, currentToken)
    assert.strictEqual(
      await store.completeSubmissionRecovery(runId, staleToken),
      false
    )
    assert.strictEqual(
      await store.completeSubmissionRecovery(runId, currentToken),
      true
    )
    const recovered = await store.getRun(runId)
    assert.strictEqual(recovered?.execution.status, 'queued')
    // An accepted replay proves the Runner did take the submission, so the execution phase
    // began then. `uncertain` deliberately left `started_at` NULL (acceptance was unknown);
    // resolving it without filling the start would leave a `queued` run with no beginning,
    // which no other path can produce and which silently breaks phase timing.
    assert.ok(
      recovered?.execution.started_at,
      'an accepted replay records when execution began'
    )
    assert.strictEqual(recovered?.execution.finished_at, null)
    assert.strictEqual(
      (await store.listActiveRuns()).runs.some(
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
  const input = { contract_version: 'v6', replay: true }
  const owner = await createStore({ connectorId: sharedConnector })
  try {
    const admission = await owner.createPreparingReviewRun({
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
          input
        },
        async () => {
          throw new RunnerSubmissionUncertainError('response lost')
        }
      ),
      RunnerSubmissionUncertainError
    )
    // An uncertain submission may have reached the Runner, so execution is `uncertain` (a
    // later recovery replays it) rather than skipped or failed.
    assert.strictEqual(
      (await owner.getRun(runId))?.execution.status,
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
      async readRunnerStatuses() {
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
      (await restarted.getRun(runId))?.execution.status,
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
    const staleToken = await ownerA.claimPublication(runId)
    const currentToken = await ownerB.claimPublication(runId)
    assert.ok(staleToken)
    assert.ok(currentToken)
    assert.notStrictEqual(staleToken, currentToken)
    assert.strictEqual(
      await ownerA.completePublication(runId, staleToken),
      false
    )
    assert.strictEqual(
      await ownerA.failPublication(
        runId,
        staleToken,
        { message: 'late failure' },
        { retry: true }
      ),
      false
    )
    assert.strictEqual(
      await ownerB.completePublication(runId, currentToken),
      true
    )
    const record = await ownerA.getRun(runId)
    assert.strictEqual(record?.publication.status, 'published')
  } finally {
    await Promise.all([ownerA.close(), ownerB.close()])
  }
})

test('ReviewRunStore does not publish while a required step is incomplete', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await store.initializePublicationSteps(runId, token, [
      'issue:summary-comment'
    ])
    const [step] = await store.listPublicationSteps(runId)
    assert.strictEqual(step?.failure_count, 0)
    assert.strictEqual(await store.completePublication(runId, token), false)
    assert.strictEqual(
      (await store.getRun(runId))?.publication.status,
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
    const token = await store.claimPublication(runId)
    assert.ok(token)
    const claimed = await store.getRun(runId)
    assert.strictEqual(claimed?.publication.status, 'publishing')
    const publicationStart = claimed?.publication.started_at
    assert.ok(publicationStart, 'the claim starts the publication phase')
    assert.strictEqual(claimed?.publication.finished_at, null)

    assert.strictEqual(
      await store.failPublication(
        runId,
        token,
        { code: 'HTTP_503', message: 'unavailable' },
        { retry: true }
      ),
      true
    )
    const record = await store.getRun(runId)
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
    assert.deepStrictEqual((await store.listActiveRuns()).runs, [])
  } finally {
    await store.close()
  }
})

test('ReviewRunStore fences publication step commits with the current publication token', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = await createSuccessfulRun(store)
  try {
    const staleToken = await store.claimPublication(runId)
    assert.ok(staleToken)
    await store.initializePublicationSteps(runId, staleToken, [
      'repository:summary-issue'
    ])
    await store.requirePublicationStepClaim(
      runId,
      staleToken,
      'repository:summary-issue'
    )

    const currentToken = await store.claimPublication(runId)
    assert.ok(currentToken)
    assert.strictEqual(
      await store.completePublicationStep(
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
      await store.failPublicationStep(
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
      const token = await store.claimPublication(runId)
      assert.ok(token)
      if (attempt === 0)
        await store.initializePublicationSteps(runId, token, [
          'issue:summary-comment'
        ])
      await store.requirePublicationStepClaim(
        runId,
        token,
        'issue:summary-comment'
      )
      assert.strictEqual(
        await store.failPublicationStep(runId, token, 'issue:summary-comment', {
          message: 'temporary failure'
        }),
        true
      )
      assert.strictEqual(
        (await store.listPublicationSteps(runId))[0]?.failure_count,
        attempt + 1
      )
      assert.strictEqual(
        await store.failPublication(
          runId,
          token,
          { message: 'temporary failure' },
          { retry: true }
        ),
        true
      )
    }

    const finalToken = await store.claimPublication(runId)
    assert.ok(finalToken)
    await assert.rejects(
      store.requirePublicationStepClaim(
        runId,
        finalToken,
        'issue:summary-comment'
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'PUBLICATION_STEP_RETRY_EXHAUSTED'
    )
    const [step] = await store.listPublicationSteps(runId)
    assert.strictEqual(step?.status, 'terminal_failed')
    assert.strictEqual(step?.failure_count, 3)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore records Runner execution failure without publication failure', async () => {
  const store = await createStore()
  const runId = await createQueuedRun(store)
  try {
    assert.strictEqual(
      await store.failRunnerExecution(runId, {
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const record = await store.getRun(runId)
    assert.strictEqual(record?.execution.status, 'failed')
    assert.strictEqual(record?.failure_code, 'RUNNER_EXECUTION_FAILED')
    assert.strictEqual(await store.claimPublication(runId), null)

    // An execution failure ends the run, so the requester has to be told. The notice names the
    // axis that failed, because the reply says the review started but could not finish rather
    // than claiming it never started.
    const notice = await store.claimNextRunFailureNotice()
    assert.notStrictEqual(notice, null)
    assert.strictEqual(notice?.run_id, runId)
    assert.strictEqual(notice?.failure_stage, 'execution')
    assert.strictEqual(notice?.failure_code, 'RUNNER_EXECUTION_FAILED')
    assert.strictEqual(
      await store.completeRunFailureNotice(
        runId,
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
      await store.failRunnerExecution(runId, {
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const notice = await store.claimNextRunFailureNotice()
    assert.ok(notice)

    // A delivery has to name where the requester can read it. Storing `delivered` with no URL
    // would claim someone was told while giving no way to check.
    await assert.rejects(
      store.completeRunFailureNotice(runId, notice.claim_token, true),
      /cannot be delivered without a comment_url/
    )

    assert.strictEqual(
      await store.completeRunFailureNotice(
        runId,
        notice.claim_token,
        true,
        commentUrl
      ),
      true
    )
    assert.strictEqual(
      (await store.getRun(runId))?.failure_notice?.comment_url,
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
      await store.failRunnerExecution(runId, {
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'Agent execution failed.'
      }),
      true
    )
    const notice = await store.claimNextRunFailureNotice()
    assert.ok(notice)
    // The connector could not reach the provider. That is a failed delivery, not a decision to
    // skip one, and the two must not share a state: an operator reading `skipped` would think
    // nothing was attempted.
    assert.strictEqual(
      await store.completeRunFailureNotice(runId, notice.claim_token, false),
      true
    )
    assert.strictEqual(
      (await store.getRun(runId))?.failure_notice?.status,
      'failed'
    )
    // The notice stays terminal: nothing retries it, by design. Reaching the provider is an
    // operator problem, not one this loop can solve by trying again.
    assert.strictEqual(await store.claimNextRunFailureNotice(), null)
  } finally {
    await store.close()
  }
})

test('ReviewRunStore announces only a publication failure that ends the run', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await store.initializePublicationSteps(runId, token, [
      'issue:summary-comment'
    ])
    await store.requirePublicationStepClaim(
      runId,
      token,
      'issue:summary-comment'
    )
    // A step that will be retried is not yet news for the requester: announcing it would post a
    // reply per attempt for a run that may still succeed.
    assert.strictEqual(
      await store.failPublicationStep(
        runId,
        token,
        'issue:summary-comment',
        { code: 'GITHUB_RATE_LIMITED', message: 'slow down' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual(
      await store.failPublication(
        runId,
        token,
        { message: 'slow down' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual(
      await store.claimNextRunFailureNotice(),
      null,
      'a retryable step failure must not produce a notice'
    )

    // The same step failing for a reason that cannot be retried ends the run, so it does.
    const terminalToken = await store.claimPublication(runId)
    assert.ok(terminalToken)
    await store.requirePublicationStepClaim(
      runId,
      terminalToken,
      'issue:summary-comment'
    )
    assert.strictEqual(
      await store.failPublicationStep(
        runId,
        terminalToken,
        'issue:summary-comment',
        { code: 'GITHUB_VALIDATION_REJECTED', message: 'rejected' },
        { retry: false }
      ),
      true
    )
    const notice = await store.claimNextRunFailureNotice()
    assert.strictEqual(notice?.run_id, runId)
    assert.strictEqual(notice?.failure_stage, 'publication')
    assert.strictEqual(notice?.failure_code, 'GITHUB_VALIDATION_REJECTED')
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
    const token = await ownerA.claimPublication(runId)
    assert.ok(token)
    await observer.query(
      "UPDATE publications SET claimed_at=clock_timestamp()-interval '2 seconds' WHERE run_id=$1 AND connector_id=$2",
      [runId, sharedConnector]
    )
    assert.strictEqual(await ownerA.renewPublicationClaim(runId, token), true)
    assert.strictEqual(await ownerB.claimPublication(runId), null)
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
    const firstToken = await store.claimPublication(runId)
    assert.ok(firstToken)
    await store.initializePublicationSteps(runId, firstToken, stepKeys)
    assert.strictEqual(
      await store.failPublication(
        runId,
        firstToken,
        { message: 'temporary failure' },
        { retry: true }
      ),
      true
    )

    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken)
    await store.initializePublicationSteps(runId, secondToken, stepKeys)

    const persisted = (await store.listPublicationSteps(runId)).map(
      (step) => step.step_key
    )
    assert.deepStrictEqual(persisted.sort(), [...stepKeys].sort())
  } finally {
    await store.close()
  }
})

test('ReviewRunStore reports a duplicate publication step set as deterministic', async () => {
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await assert.rejects(
      store.initializePublicationSteps(runId, token, [
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
    const firstToken = await store.claimPublication(runId)
    assert.ok(firstToken)
    await store.initializePublicationSteps(runId, firstToken, [
      'repository:summary-issue'
    ])
    assert.strictEqual(
      await store.failPublication(
        runId,
        firstToken,
        { message: 'temporary failure' },
        { retry: true }
      ),
      true
    )

    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken)
    await assert.rejects(
      store.initializePublicationSteps(runId, secondToken, [
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
  // `claimNextPublication` hands the publisher everything it needs to publish: the Runner's
  // opaque result, the publish context, and the artifact reference, alongside the claim
  // token. `claimPublication` (covered above) only returns a token, so this is the shape a
  // publisher actually receives and must match what was persisted.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const context = { repository: 'octo/example' }
  const admission = await store.createPreparingReviewRun({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: context
  })
  assert.ok(admission.preparation_token)
  await store.markQueued(runId, admission.preparation_token, context)
  const workflowResult = {
    run_id: runId,
    review_record: { analysis: { verdict: 'no-findings' } }
  }
  assert.strictEqual(
    await store.recordRunnerSuccess(runId, workflowResult, {
      status: 'unavailable'
    }),
    true
  )
  try {
    const work = await store.claimNextPublication()
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
    const work = await restarted.claimNextPublication()
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
      first.claimNextPublication(),
      second.claimNextPublication()
    ])
    assert.strictEqual(claims.filter((claim) => claim !== null).length, 1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('a retryable publication failure makes the run claimable again', async () => {
  // The counterpart to `spends retry budget only for the current publication owner`, which
  // asserts the retryable failure is accepted: this asserts the run becomes claimable again
  // afterwards, so the retry the budget allowed actually happens.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const work = await store.claimNextPublication()
    assert.ok(work)
    assert.strictEqual(
      await store.failPublication(
        runId,
        work.claim_token,
        { message: 'GitHub unavailable' },
        { retry: true }
      ),
      true
    )
    assert.strictEqual((await store.claimNextPublication())?.run_id, runId)
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
      store.recordArtifactStorage(runId, { status: 'available' }),
      new RegExp(
        `run ${runId} is an available artifact storage record without its artifact`
      )
    )
    await assert.rejects(
      store.recordRunnerSuccess(
        runId,
        { run_id: runId },
        { status: 'available' }
      ),
      /without its artifact reference/
    )
    await assert.rejects(
      store.failRunnerExecution(
        runId,
        { message: 'failed' },
        { status: 'available' }
      ),
      /without its artifact reference/
    )
    // Nothing was written: the run is still exactly as it was queued.
    assert.strictEqual((await store.getRun(runId))?.artifact_storage, null)
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
    (await store.listEvents(runId))
      .filter((event) => event.axis === 'publication')
      .map((event) => `${event.from_status}->${event.to_status}`)
  try {
    // Terminal execution failure skips publication.
    const failedRun = await createQueuedRun(store)
    assert.strictEqual(
      await store.failRunnerExecution(failedRun, {
        code: 'RUNNER_EXECUTION_FAILED',
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
    assert.ok(await store.claimPublication(claimedRun))
    assert.deepStrictEqual(await publicationEvents(claimedRun), [
      'null->pending',
      'pending->publishing'
    ])

    // An uncertain submission may still be accepted, so publication must NOT be ruled out yet:
    // it stays `pending` until execution is conclusively skipped or failed.
    const recoveredRun = `run-${randomUUID()}`
    const admitted = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: recoveredRun,
      publish_context: {}
    })
    assert.ok(admitted.preparation_token)
    await store.failPreparation(
      recoveredRun,
      admitted.preparation_token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    assert.strictEqual(
      (await store.getRun(recoveredRun))?.publication.status,
      'pending',
      'an uncertain submission must not skip publication'
    )
    const recoveryToken = await store.claimSubmissionRecovery(recoveredRun)
    assert.ok(recoveryToken)
    assert.strictEqual(
      await store.completeSubmissionRecovery(recoveredRun, recoveryToken),
      true
    )
    assert.deepStrictEqual(await publicationEvents(recoveredRun), [
      'null->pending'
    ])

    // Only a rejected replay proves there is nothing to publish.
    const rejectedRun = `run-${randomUUID()}`
    const rejectedAdmission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: rejectedRun,
      publish_context: {}
    })
    assert.ok(rejectedAdmission.preparation_token)
    await store.failPreparation(
      rejectedRun,
      rejectedAdmission.preparation_token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    const rejectedToken = await store.claimSubmissionRecovery(rejectedRun)
    assert.ok(rejectedToken)
    assert.strictEqual(
      await store.failSubmissionRecovery(rejectedRun, rejectedToken, {
        code: 'SUBMISSION_FAILED',
        message: 'no'
      }),
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)

    // Admitted but not claimed again: the preparation claim taken at admission started the
    // phase, and nothing has ended yet.
    const admitted = await store.getRun(runId)
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
    await store.markQueued(runId, admission.preparation_token, {})
    const queued = await store.getRun(runId)
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
      await store.recordRunnerSuccess(
        runId,
        { run_id: runId },
        { status: 'unavailable' }
      ),
      true
    )
    const succeeded = await store.getRun(runId)
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
    const token = await store.claimPublication(runId)
    assert.ok(token)
    const publishing = await store.getRun(runId)
    assert.strictEqual(publishing?.publication.status, 'publishing')
    const publicationStart = publishing?.publication.started_at
    assert.ok(publicationStart, 'first claim starts publication')

    await store.initializePublicationSteps(runId, token, ['repository:comment'])
    assert.strictEqual(
      await store.failPublication(
        runId,
        token,
        { code: 'GITHUB_RATE_LIMITED', message: 'slow down' },
        { retry: true }
      ),
      true
    )
    const retried = await store.getRun(runId)
    assert.strictEqual(retried?.publication.status, 'pending')
    assert.strictEqual(
      retried?.publication.started_at,
      publicationStart,
      'a retryable failure keeps the original publication start'
    )

    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken)
    assert.strictEqual(
      (await store.getRun(runId))?.publication.started_at,
      publicationStart,
      're-claiming keeps the original publication start'
    )

    // The end of each phase is stable across later writes.
    const before = await store.getRun(runId)
    await store.touchObservation(runId)
    await store.recordArtifactStorage(runId, { status: 'unavailable' })
    const after = await store.getRun(runId)
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    const started = (await store.getRun(runId))?.preparation?.started_at
    assert.ok(started)

    // A retryable failure returns the row to pending for another attempt.
    const result = await store.failPreparation(
      runId,
      admission.preparation_token,
      { code: 'PREPARATION_TRANSIENT', message: 'try again' },
      { retry: true, retryAfterMs: 0 }
    )
    assert.deepStrictEqual(result, { retry_scheduled: true })
    assert.strictEqual(
      (await store.getRun(runId))?.preparation?.started_at,
      started,
      'a re-pend keeps the original start'
    )

    const next = await store.claimNextPreparation()
    assert.ok(next)
    assert.strictEqual(
      (await store.getRun(runId))?.preparation?.started_at,
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.failPreparation(
      runId,
      admission.preparation_token,
      { code: 'GITHUB_RATE_LIMITED', message: 'rate limited' },
      { retry: true }
    )

    // The coordinator claims the retry. This is the step that erases `failure_code`.
    const work = await store.claimNextPreparation()
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
    await store.expireStalePreparations()

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
    const publicationEvents = (await store.listEvents(runId))
      .filter((event) => event.axis === 'publication')
      .map((event) => `${event.from_status}->${event.to_status}`)
    assert.deepStrictEqual(publicationEvents, [
      'null->pending',
      'pending->skipped'
    ])

    const notice = await store.claimNextRunFailureNotice()
    assert.ok(notice)
    assert.strictEqual(notice.failure_code, 'GITHUB_RATE_LIMITED')
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
    await store.createPreparingReviewRun({
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
    await store.expireStalePreparations()

    const notice = await store.claimNextRunFailureNotice()
    assert.ok(notice)
    assert.strictEqual(notice.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
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
    const token = await store.claimPublication(runId)
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
      await store.failRunnerExecution(runId, {
        code: 'RUNNER_LOST',
        message: 'expected output'
      }),
      true
    )

    const record = await store.getRun(runId)
    assert.strictEqual(record?.execution.status, 'failed')
    assert.strictEqual(
      record?.publication.status,
      'skipped',
      'a publication in flight must not be stranded when execution fails'
    )
    assert.strictEqual(record?.publication.finished_at !== null, true)

    const events = await store.listEvents(runId)
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
    const token = await store.claimPublication(runId)
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
    const claimToken = await store.claimSubmissionRecovery(runId)
    assert.notStrictEqual(claimToken, null)
    assert.strictEqual(
      await store.failSubmissionRecovery(runId, claimToken as string, {
        code: 'SUBMISSION_REJECTED',
        message: 'replay rejected'
      }),
      true
    )

    const record = await store.getRun(runId)
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
    const token = await store.claimPublication(runId)
    assert.notStrictEqual(token, null)
    assert.strictEqual(
      await store.failPublication(
        runId,
        token as string,
        { code: null, message: 'no code' },
        { retry: false }
      ),
      true
    )
    const noCode = await store.getRun(runId)
    assert.strictEqual(noCode?.publication.status, 'failed')
    assert.strictEqual(noCode?.failure_code, null)
  } finally {
    await store.close()
  }

  const second = await createStore()
  const secondRunId = await createSuccessfulRun(second)
  try {
    const token = await second.claimPublication(secondRunId)
    assert.notStrictEqual(token, null)
    await second.failPublication(
      secondRunId,
      token as string,
      { code: 'GITHUB_FORBIDDEN', message: 'forbidden' },
      { retry: false }
    )
    const record = await second.getRun(secondRunId)
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
    const admitted = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admitted.preparation_token)
    await store.failPreparation(
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

    const token = await store.claimSubmissionRecovery(runId)
    assert.ok(token)
    assert.strictEqual(
      await store.completeSubmissionRecovery(runId, token),
      false,
      'an accepted replay must not queue an execution whose publication is gone'
    )
    const record = await store.getRun(runId)
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
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: admitted,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.markQueued(admitted, admission.preparation_token, {})
    assert.strictEqual(
      (await store.getRun(admitted))?.execution.status,
      'queued'
    )

    // Negative: once publication is concluded, the same submit must fail and roll back whole.
    const refused = `run-${randomUUID()}`
    const refusedAdmission = await store.createPreparingReviewRun({
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
      store.markQueued(refused, refusedAdmission.preparation_token, {}),
      /cannot transition from pending to queued/,
      'a concluded publication must reject the submission'
    )
    const record = await store.getRun(refused)
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

test('a preparation failure refuses to commit when its claim was taken mid-transaction', async () => {
  // `failPreparation` closes the preparation row first, and that UPDATE doubles as the claim
  // check: it only matches while the row is still `preparing` under our token. If another writer
  // (an expired lease in `expireStale`) replaces the row before it runs, the UPDATE matches
  // nothing and the whole cross-axis failure aborts instead of recording `preparing -> failed`
  // on a claim that is no longer ours.
  //
  // A trigger stands in for that writer by rewriting the row just before the statement that
  // checks it, which is exactly the window a concurrent lease expiry occupies. A normal call
  // cannot produce this interleaving, so the trigger is what makes the race deterministic.
  const store = await createStore()
  const runId = `run-${randomUUID()}`
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const admission = await store.createPreparingReviewRun({
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
      await assert.rejects(
        store.failPreparation(
          runId,
          admission.preparation_token,
          { code: 'PREPARATION_INPUT_INVALID', message: 'cannot build input' },
          { retry: false }
        ),
        /lost its claim before it could be marked failed/,
        'a claim lost before the closing update must abort the failure'
      )
      // The whole cross-axis failure rolled back: the preparation keeps the state the competing
      // writer left, and no audit event claims a transition this transaction did not make.
      const record = await store.getRun(runId)
      assert.strictEqual(
        record?.preparation.status,
        'preparing',
        'a lost claim must not be recorded as a terminal failure'
      )
      assert.strictEqual(record?.execution.status, 'pending')
      assert.deepStrictEqual(
        (await store.listEvents(runId)).map(
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
    const admission = await store.createPreparingReviewRun({
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
      store.savePreparedSubmission(
        runId,
        admission.preparation_token,
        { target: 'overwritten' },
        { contract_version: 'v6' }
      ),
      /cannot save prepared submission outside pending/,
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
    const firstToken = await store.claimPublication(runId)
    assert.ok(firstToken)
    // The lease is still fresh, so nobody else may take it.
    assert.strictEqual(await store.claimPublication(runId), null)

    await new Promise((resolve) => setTimeout(resolve, 120))
    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken, 'an expired lease must be reclaimable')
    assert.notStrictEqual(secondToken, firstToken)

    // The old owner is fenced out at every write.
    assert.strictEqual(
      await store.completePublication(runId, firstToken),
      false
    )
    await assert.rejects(
      store.requirePublicationStepClaim(runId, firstToken, 'x')
    )

    // The new owner finishes the publication.
    await store.initializePublicationSteps(runId, secondToken, ['x'])
    await store.requirePublicationStepClaim(runId, secondToken, 'x')
    await store.completePublicationStep(runId, secondToken, 'x')
    assert.strictEqual(
      await store.completePublication(runId, secondToken),
      true
    )
    assert.strictEqual(
      (await store.getRun(runId))?.publication.status,
      'published'
    )

    // The takeover is auditable, not silent.
    const publicationEvents = (await store.listEvents(runId))
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
  // A step found `running` belongs to a publisher that may have died mid-effect. Control Plane
  // cannot know whether the side effect happened, so it must not let a reclaim look like a first
  // attempt: `attempt_count` and `last_attempt_at` are what let the connector treat a reclaim as
  // a retry and reconcile against the remote object instead of repeating the call blindly.
  const store = await createStore({ claimTimeoutMs: 50 })
  const runId = await createSuccessfulRun(store)
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await store.initializePublicationSteps(runId, token, ['comment'])
    assert.strictEqual(
      (await store.listPublicationSteps(runId))[0]?.attempt_count,
      0,
      'an untouched step has never been attempted'
    )

    await store.requirePublicationStepClaim(runId, token, 'comment')
    const first = (await store.listPublicationSteps(runId))[0]
    assert.strictEqual(first?.attempt_count, 1)
    assert.ok(
      first?.last_attempt_at,
      'the first attempt records when it started'
    )

    // The publisher "dies" here: the step stays `running`. A new owner reclaims it once the
    // publication lease expires.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const secondToken = await store.claimPublication(runId)
    assert.ok(secondToken)
    await store.requirePublicationStepClaim(runId, secondToken, 'comment')
    const second = (await store.listPublicationSteps(runId))[0]
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
  // a real Runner result. The old behaviour threw from inside the shared expiry transaction, and
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
      await store.createPreparingReviewRun({
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

    const first = await store.expireStalePreparations()
    assert.strictEqual(first.concluded, 1, 'the healthy run is still concluded')
    assert.deepStrictEqual(first.blocked, [
      { run_id: corruptRunId, reason: 'EXECUTION_ALREADY_ADVANCED' }
    ])

    // The healthy run is fully concluded even though a sibling failed.
    const healthy = await store.getRun(healthyRunId)
    assert.strictEqual(healthy?.preparation?.status, 'failed')
    assert.strictEqual(healthy?.execution.status, 'skipped')
    assert.strictEqual(healthy?.publication.status, 'skipped')

    // The corrupt run's story is left exactly as it was, contradiction intact and repairable.
    const corrupt = await store.getRun(corruptRunId)
    assert.strictEqual(corrupt?.preparation?.status, 'preparing')
    assert.strictEqual(corrupt?.execution.status, 'succeeded')
    assert.strictEqual(corrupt?.publication.status, 'publishing')

    // The block is durable: a later pass neither retries nor re-reports the same row. Without
    // this, every tick would repeat the failing transition forever.
    const second = await store.expireStalePreparations()
    assert.strictEqual(second.concluded, 0)
    assert.deepStrictEqual(second.blocked, [])

    const marker = await pool.query<{
      expiry_blocked_reason: string | null
      expiry_blocked_at: Date | null
    }>(
      `SELECT expiry_blocked_reason, expiry_blocked_at FROM preparations WHERE run_id=$1`,
      [corruptRunId]
    )
    assert.strictEqual(
      marker.rows[0]?.expiry_blocked_reason,
      'EXECUTION_ALREADY_ADVANCED'
    )
    assert.notStrictEqual(marker.rows[0]?.expiry_blocked_at, null)
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
    const activeAdmission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: activeRunId,
      publish_context: {}
    })
    await store.markQueued(activeRunId, activeAdmission.preparation_token!, {})
    await store.createPreparingReviewRun({
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
      async readRunnerStatuses() {
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

test('abandoning a blocked run concludes its open axes and keeps the execution evidence', async () => {
  // The operator path for a blocked run. It is an abandonment, not a repair: the open axes are
  // concluded so the run stops holding work nobody can conclude, while the execution axis keeps
  // the result the Runner actually produced. Nothing is deleted, and the ingress identity stays,
  // so a replay of the same webhook resolves to this run instead of starting a second one.
  const store = await createStore({ claimTimeoutMs: 0 })
  const pool = new Pool({ connectionString: requireTestDatabase() })
  const runId = `run-blocked-${randomUUID()}`
  const ingress = {
    kind: 'github_webhook' as const,
    key: `delivery-${randomUUID()}`
  }
  try {
    await store.admitReviewRun({
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
    const expiry = await store.expireStalePreparations()
    assert.deepStrictEqual(expiry.blocked, [
      { run_id: runId, reason: 'EXECUTION_ALREADY_ADVANCED' }
    ])
    assert.deepStrictEqual(await store.listBlockedPreparationExpiries(), [
      { run_id: runId, reason: 'EXECUTION_ALREADY_ADVANCED' }
    ])

    // A blank reason is refused: an abandonment must always say why it happened.
    await assert.rejects(
      store.abandonBlockedPreparation(runId, '   '),
      /reason is required/
    )
    // A run that is not blocked cannot be abandoned through this path, which is what keeps it
    // from becoming a general state-jumping endpoint.
    await assert.rejects(
      store.abandonBlockedPreparation(`run-${randomUUID()}`, 'not blocked'),
      /is not a blocked preparation/
    )

    const abandoned = await store.abandonBlockedPreparation(
      runId,
      'execution result will not be delivered'
    )
    assert.strictEqual(abandoned.preparation.status, 'failed')
    assert.strictEqual(
      abandoned.preparation.failure_code,
      'PREPARATION_ABANDONED'
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
    assert.deepStrictEqual(await store.listBlockedPreparationExpiries(), [])
    const events = await store.listEvents(runId)
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'preparation' &&
          event.to_status === 'failed' &&
          event.reason_code === 'PREPARATION_ABANDONED'
      )
    )
    assert.ok(
      events.some(
        (event) =>
          event.axis === 'publication' &&
          event.from_status === 'publishing' &&
          event.to_status === 'skipped'
      )
    )

    // Nothing was deleted: the same ingress identity still resolves to this run.
    const replay = await store.admitReviewRun({
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

test('an owner cannot claim a publication step it already holds', async () => {
  // A step left `running` may belong to a publisher that died mid-effect, so a *different*
  // publication token must be able to take it over. The same token must not: it would start a
  // second attempt for one side effect, inflating the attempt count that reconciliation reads to
  // decide whether an earlier owner already ran. Before `claimed_by` existed the two cases were
  // indistinguishable, and claiming twice under one token silently incremented the count.
  const store = await createStore()
  const runId = await createSuccessfulRun(store)
  try {
    const token = await store.claimPublication(runId)
    assert.ok(token)
    await store.initializePublicationSteps(runId, token, ['s'])

    await store.requirePublicationStepClaim(runId, token, 's')
    assert.strictEqual(
      (await store.listPublicationSteps(runId))[0]?.attempt_count,
      1
    )
    await assert.rejects(
      store.requirePublicationStepClaim(runId, token, 's'),
      /not claimable/,
      'the holder must not start a second attempt on its own running step'
    )
    assert.strictEqual(
      (await store.listPublicationSteps(runId))[0]?.attempt_count,
      1,
      'the refused claim must not touch the attempt count'
    )
  } finally {
    await store.close()
  }
})
