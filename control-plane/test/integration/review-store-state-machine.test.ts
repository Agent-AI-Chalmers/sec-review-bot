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
    assert.strictEqual(queued?.runner_status, 'queued')
    assert.deepStrictEqual(queued?.artifact_storage, artifactStorage)
    assert.deepStrictEqual(
      (await store.listActiveRuns()).runs.map((entry) => entry.run_id),
      [queuedId]
    )
  } finally {
    await store.close()
  }
})

test('submitted_at marks the instant execution began and does not move afterwards', async () => {
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
    assert.strictEqual((await store.getRun(runId))?.submitted_at, null)

    await store.markQueued(runId, admission.preparation_token, {})
    const queued = await store.getRun(runId)
    assert.ok(queued?.submitted_at)
    const submittedAt = queued?.submitted_at

    // A later, non-transitional write (the artifact mtime) must not move submitted_at.
    await store.recordArtifactStorage(runId, { status: 'unavailable' })
    const after = await store.getRun(runId)
    assert.strictEqual(after?.submitted_at, submittedAt)
    assert.ok(
      Date.parse(after!.execution_updated_at) >= Date.parse(submittedAt!),
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
      (event) => event.axis === 'runner'
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
      (event) => event.axis === 'runner'
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
    assert.ok(axes.includes('runner:pending'))
    assert.ok(axes.includes('preparation:preparing'))
    assert.ok(axes.includes('publication:pending'))
    assert.ok(axes.includes('runner:queued'))
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
    assert.strictEqual(before?.runner_status, 'queued')
    // The heartbeat must move the mtime forward even though the status is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.touchObservation(runId)
    const after = await store.getRun(runId)
    assert.strictEqual(after?.runner_status, 'queued', 'state is unchanged')
    assert.ok(
      Date.parse(after!.execution_updated_at) >
        Date.parse(before!.execution_updated_at),
      'the row mtime moved forward'
    )
    // It must not touch a run that is not being polled.
    const admitted = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: `run-${randomUUID()}`,
      publish_context: {}
    })
    const preparingBefore = admitted.record.execution_updated_at
    await store.touchObservation(admitted.record.run_id)
    assert.strictEqual(
      (await store.getRun(admitted.record.run_id))?.execution_updated_at,
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
    assert.strictEqual((await store.getRun(runId))?.runner_status, 'uncertain')

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

test('ReviewRunStore returns an expired preparation to pending without failing its run', async () => {
  const store = await createStore({ claimTimeoutMs: 0 })
  const runId = `run-stale-preparation-${randomUUID()}`
  try {
    await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })

    assert.strictEqual(await store.expireStalePreparations(), 1)
    const run = await store.getRun(runId)
    assert.strictEqual(run?.runner_status, 'pending')
    assert.strictEqual(run?.failure_code, null)
    assert.strictEqual(run?.preparation?.status, 'pending')
    assert.strictEqual(run?.preparation?.attempt_count, 1)
    assert.strictEqual(run?.preparation?.failure_notice_status, null)
    assert.strictEqual(await store.claimPublication(runId), null)
    assert.strictEqual(await store.expireStalePreparations(), 0)
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
    assert.strictEqual(await store.expireStalePreparations(), 1)
    const run = await store.getRun(runId)
    assert.strictEqual(run?.runner_status, 'skipped')
    assert.strictEqual(run?.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.deepStrictEqual(
      {
        status: run?.preparation?.status,
        attempt_count: run?.preparation?.attempt_count,
        failure_code: run?.preparation?.failure_code,
        failure_notice_status: run?.preparation?.failure_notice_status
      },
      {
        status: 'failed',
        attempt_count: 8,
        failure_code: 'PREPARATION_RETRY_EXHAUSTED',
        failure_notice_status: 'pending'
      }
    )
    assert.strictEqual(await store.claimNextPreparation(), null)
    assert.strictEqual(await store.claimPublication(runId), null)
    const notice = await store.claimNextPreparationFailureNotice()
    assert.ok(notice)
    assert.strictEqual(notice.run_id, runId)
    assert.deepStrictEqual(notice.input, {})
    assert.strictEqual(notice.failure_code, 'PREPARATION_RETRY_EXHAUSTED')
    assert.strictEqual(
      (await store.getRun(runId))?.preparation?.failure_notice_status,
      'delivering'
    )
    assert.strictEqual(
      await store.completePreparationFailureNotice(runId, randomUUID(), true),
      false
    )
    assert.strictEqual(
      await store.completePreparationFailureNotice(
        runId,
        notice.claim_token,
        true
      ),
      true
    )
    assert.strictEqual(
      (await store.getRun(runId))?.preparation?.failure_notice_status,
      'delivered'
    )
    assert.strictEqual(await store.claimNextPreparationFailureNotice(), null)
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

    const first = await store.claimNextPreparationFailureNotice()
    assert.ok(first)
    // Expire its lease, then claim again: the notice was already `delivering`.
    await observer.query(
      `UPDATE preparation_failure_notices SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    const second = await store.claimNextPreparationFailureNotice()
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
    assert.strictEqual(await producer.expireStalePreparations(), 1)

    const claims = await Promise.all([
      first.claimNextPreparationFailureNotice(),
      second.claimNextPreparationFailureNotice()
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
    assert.strictEqual(await store.expireStalePreparations(), 1)

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
    assert.strictEqual(await first.expireStalePreparations(), 1)

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
    assert.strictEqual(await store.expireStalePreparations(), 0)

    await observer.query(
      `UPDATE preparations SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [runId]
    )
    assert.strictEqual(await store.expireStalePreparations(), 1)
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
    assert.strictEqual(failed?.runner_status, 'skipped')
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
    assert.strictEqual(record?.runner_status, 'pending')
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

    assert.strictEqual(await ownerB.expireStalePreparations(), 1)
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
      /claim was lost/
    )
    await ownerB.markQueued(takeover.run_id, takeover.claim_token, {})
    assert.strictEqual(
      (await ownerA.getRun(first.record.run_id))?.runner_status,
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
    assert.strictEqual((await store.getRun(runId))?.runner_status, 'queued')
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
    assert.strictEqual((await owner.getRun(runId))?.runner_status, 'uncertain')
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
      }
    })

    assert.deepStrictEqual(submissions, [
      { workflow: 'issue-review', run_id: runId, input }
    ])
    assert.strictEqual((await restarted.getRun(runId))?.runner_status, 'queued')
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
    assert.strictEqual(record?.publication_status, 'published')
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
      (await store.getRun(runId))?.publication_status,
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
    assert.strictEqual(record?.runner_status, 'succeeded')
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
    assert.strictEqual(record?.runner_status, 'failed')
    assert.strictEqual(record?.failure_code, 'RUNNER_EXECUTION_FAILED')
    assert.strictEqual(await store.claimPublication(runId), null)
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
      (await store.getRun(recoveredRun))?.publication_status,
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
