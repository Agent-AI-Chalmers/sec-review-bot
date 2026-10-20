// The contract's `x-state-machines` block claims to describe the transitions the write paths
// perform. These tests compare that claim with the transitions the stores actually *record*
// into the audit log, in both directions:
//
//   - an edge the code records but the contract omits means the diagram is wrong;
//   - an edge the contract declares but no code path produces means the diagram promises
//     behaviour nothing backs.
//
// Both directions are driven from real write paths. An earlier version checked the second
// direction against a hand-maintained list of edge names, which could only ever agree with
// itself: it passed while a renamed transition (`delivering->skipped` becoming
// `delivering->failed`) had gone stale in the very list it was asserting on.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  STATE_MACHINES,
  type StateAxis
} from '../../src/state-machines.generated.js'
import { Pool } from 'pg'

import { ReviewRunStore } from '../../src/index.js'

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

async function createStore(
  options: { claimTimeoutMs?: number } = {}
): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: `edges:${randomUUID()}`,
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

function declaredEdges(axis: StateAxis): Set<string> {
  const machine = STATE_MACHINES.find((candidate) => candidate.axis === axis)
  assert.ok(machine, `the contract declares an ${axis} machine`)
  return new Set(machine.transitions.map((edge) => `${edge.from}->${edge.to}`))
}

/** Claim from the notice queue until the given run's notice is in hand.
 *
 * `claimNextRunNotice` is a queue, not a lookup: other runs' notices queued earlier would
 * otherwise be claimed here and left dangling, which is exactly how an earlier version of this
 * driver failed to exercise `delivering -> failed` while appearing to.
 */
async function claimNoticeFor(
  store: ReviewRunStore,
  runId: string
): Promise<{ notice_id: string; claim_token: string }> {
  const deferred: Array<{
    notice_id: string
    run_id: string
    claim_token: string
  }> = []
  const deadline = Date.now() + 5_000
  try {
    while (Date.now() < deadline) {
      const notice = await store.claimNextRunNotice()
      if (notice === null) break
      if (notice.run_id === runId)
        return { notice_id: notice.notice_id, claim_token: notice.claim_token }
      deferred.push({
        notice_id: notice.notice_id,
        run_id: notice.run_id,
        claim_token: notice.claim_token
      })
    }
    throw new Error(`no failure notice was queued for ${runId}`)
  } finally {
    // Put the others back so later paths still see them; a notice left in `delivering` would
    // only become claimable again after its lease expires. These are parked as failed rather
    // than delivered: no reply was attempted for them, so claiming one was delivered would be a
    // lie that the URL check now rejects.
    for (const other of deferred) {
      await store.completeRunNotice(other.notice_id, other.claim_token, false)
    }
  }
}

interface RecordedEdge {
  axis: StateAxis
  edge: string
  reason: string | null
}

/** Drive every store path that moves a run, and return the transitions it recorded.
 *
 * Each block is one path, and together they are the whole write surface: preparation success
 * and failure, an expired lease, a blocked expiry resolved by an operator, submission
 * uncertainty and its recovery, every execution outcome, publication success, failure, retry,
 * abandonment, and failure-notice delivery in both its delivered and undeliverable forms.
 */
async function recordEveryPath(): Promise<RecordedEdge[]> {
  const runIds: string[] = []
  const store = await createStore({ claimTimeoutMs: 1 })
  const pool = new Pool({ connectionString: requireTestDatabase() })
  try {
    const newPreparingRun = async (): Promise<{
      runId: string
      token: string
    }> => {
      const runId = `run-${randomUUID()}`
      const admission = await store.createPreparingReviewRun({
        workflow: 'issue-review',
        run_id: runId,
        publish_context: {}
      })
      assert.ok(admission.preparation_token)
      runIds.push(runId)
      return { runId, token: admission.preparation_token }
    }
    const newSuccessRun = async (): Promise<string> => {
      const runId = await createQueuedRun(store)
      runIds.push(runId)
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
    const newPublishingRun = async (): Promise<{
      runId: string
      token: string
    }> => {
      const runId = await newSuccessRun()
      const token = await store.claimPublication(runId)
      assert.notStrictEqual(token, null)
      await store.initializePublicationSteps(runId, token as string, [
        'issue:summary-comment'
      ])
      return { runId, token: token as string }
    }

    // preparation: preparing -> submitted, then execution pending -> queued.
    const submitted = await newPreparingRun()
    await store.markQueued(submitted.runId, submitted.token, {})

    // preparation: preparing -> failed, execution pending -> skipped, notice pending -> ...
    const failedPreparation = await newPreparingRun()
    await store.failPreparation(
      failedPreparation.runId,
      failedPreparation.token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' },
      { retry: false }
    )
    const preparedNotice = await store.claimNextRunNotice()
    assert.notStrictEqual(preparedNotice, null)
    await store.completeRunNotice(
      preparedNotice?.notice_id ?? '',
      preparedNotice?.claim_token ?? '',
      true,
      'https://github.com/example/example/issues/1#issuecomment-1'
    )

    // notice: delivering -> delivering when the delivery lease expires and another worker
    // re-claims, which is the only way a notice becomes retryable again.
    const relased = await newPreparingRun()
    await store.failPreparation(
      relased.runId,
      relased.token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' },
      { retry: false }
    )
    assert.notStrictEqual(await store.claimNextRunNotice(), null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.notStrictEqual(await store.claimNextRunNotice(), null)

    // notice: delivering -> failed when the provider cannot be reached.
    const undeliverable = await newPreparingRun()
    await store.failPreparation(
      undeliverable.runId,
      undeliverable.token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' },
      { retry: false }
    )
    const undeliverableNotice = await claimNoticeFor(store, undeliverable.runId)
    await store.completeRunNotice(
      undeliverableNotice.notice_id,
      undeliverableNotice.claim_token,
      false
    )

    // preparation: preparing -> pending on a retryable failure, then pending -> preparing when
    // the next preparer claims it. Both halves matter: the second is the only path that returns
    // a run to active preparation without leaving the phase.
    const retryable = await newPreparingRun()
    await store.failPreparation(
      retryable.runId,
      retryable.token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'retrying' },
      { retry: true }
    )
    const reclaimed = await store.claimNextPreparation()
    assert.notStrictEqual(reclaimed, null)

    // preparation: preparing -> uncertain when the lease lapses without exhausting retries, and
    // uncertain -> preparing when a preparer picks it up again. The origin state is Control
    // Plane's own bookkeeping: it names the audit event below, and is not published to the
    // connector.
    await newPreparingRun()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const expiry = await store.expireStalePreparations()
    assert.ok(expiry.concluded >= 1)
    const fromUncertain = await store.claimNextPreparation()
    assert.notStrictEqual(fromUncertain, null)

    // execution: pending -> uncertain on an unconfirmed submission, then the recovery claim
    // records uncertain -> uncertain before resolving it.
    const uncertain = await newPreparingRun()
    await store.failPreparation(
      uncertain.runId,
      uncertain.token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    const recovery = await store.claimSubmissionRecovery(uncertain.runId)
    assert.notStrictEqual(recovery, null)
    // Resolving the replay moves the run back to `queued`. The unresolved branch stays
    // `uncertain` and is covered by the recovery's own expiry paths in the store tests.
    assert.strictEqual(
      await store.completeSubmissionRecovery(
        uncertain.runId,
        recovery as string
      ),
      true
    )

    // execution: uncertain -> disconnected when automatic recovery reaches its budget. This is
    // deliberately not a failure: a prior idempotent submission may still exist at the Runner.
    const uncertainDisconnects = await newPreparingRun()
    await store.failPreparation(
      uncertainDisconnects.runId,
      uncertainDisconnects.token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    assert.notStrictEqual(
      await store.disconnectExhaustedSubmissionRecovery(
        uncertainDisconnects.runId,
        0
      ),
      null
    )
    // execution: disconnected -> uncertain when an operator hands it back. Without this the run
    // would stay parked forever: automatic recovery only claims `uncertain`.
    await store.resumeDisconnectedExecution(uncertainDisconnects.runId)

    // execution: disconnected -> failed when an operator stops waiting. This does not claim the
    // task never ran - the Runner may still have it - only that the outcome will not be awaited.
    const giveUpExecution = await newPreparingRun()
    await store.failPreparation(
      giveUpExecution.runId,
      giveUpExecution.token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    assert.notStrictEqual(
      await store.disconnectExhaustedSubmissionRecovery(
        giveUpExecution.runId,
        0
      ),
      null
    )
    await store.giveUpDisconnectedRun(
      giveUpExecution.runId,
      'operator stopped waiting'
    )

    // execution: uncertain -> failed when the replay concludes the submission was not accepted.
    const uncertainFails = await newPreparingRun()
    await store.failPreparation(
      uncertainFails.runId,
      uncertainFails.token,
      { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'unknown' },
      { retry: false }
    )
    const failingRecovery = await store.claimSubmissionRecovery(
      uncertainFails.runId
    )
    assert.notStrictEqual(failingRecovery, null)
    assert.strictEqual(
      await store.failSubmissionRecovery(
        uncertainFails.runId,
        failingRecovery as string,
        { code: 'RUNNER_EXECUTION_FAILED', message: 'replay rejected' }
      ),
      true
    )

    // execution: pending -> queued -> running -> succeeded.
    const observed = await newPreparingRun()
    await store.markQueued(observed.runId, observed.token, {})
    await store.markRunning(observed.runId)
    await store.recordRunnerSuccess(
      observed.runId,
      { run_id: observed.runId },
      { status: 'unavailable' }
    )

    // execution: pending -> queued -> failed without ever running, which also skips publication.
    const queuedFailed = await newPreparingRun()
    await store.markQueued(queuedFailed.runId, queuedFailed.token, {})
    await store.failRunnerExecution(queuedFailed.runId, {
      code: 'RUNNER_EXECUTION_FAILED',
      message: 'boom'
    })

    // execution: pending -> queued -> running -> failed, which also skips publication.
    const runnerFailed = await newPreparingRun()
    await store.markQueued(runnerFailed.runId, runnerFailed.token, {})
    await store.markRunning(runnerFailed.runId)
    await store.failRunnerExecution(runnerFailed.runId, {
      code: 'RUNNER_EXECUTION_FAILED',
      message: 'boom'
    })

    // publication: pending -> publishing -> publishing (expired lease) -> published.
    const published = await newPublishingRun()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Re-claiming after the lease expires issues a new token, and the old one is fenced out.
    const renewedToken = await store.claimPublication(published.runId)
    assert.notStrictEqual(renewedToken, null)
    await store.requirePublicationStepClaim(
      published.runId,
      renewedToken as string,
      'issue:summary-comment'
    )
    await store.completePublicationStep(
      published.runId,
      renewedToken as string,
      'issue:summary-comment',
      { id: '1' }
    )
    await store.completePublication(published.runId, renewedToken as string)

    // publication: publishing -> failed on a terminal step failure.
    const publishFailed = await newPublishingRun()
    await store.requirePublicationStepClaim(
      publishFailed.runId,
      publishFailed.token,
      'issue:summary-comment'
    )
    await store.failPublicationStep(
      publishFailed.runId,
      publishFailed.token,
      'issue:summary-comment',
      { code: 'GITHUB_VALIDATION_REJECTED', message: 'rejected' },
      { retry: false }
    )
    await store.failPublication(
      publishFailed.runId,
      publishFailed.token,
      { code: 'GITHUB_VALIDATION_REJECTED', message: 'rejected' },
      { retry: false }
    )

    // publication: publishing -> uncertain when a step runs out of attempts, because the last
    // attempt may have taken effect remotely and only a reconciliation can say. The axis follows
    // its step, which is what puts the run in the operator's view without freezing the rest.
    const publishUncertain = await newPublishingRun()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.requirePublicationStepClaim(
        publishUncertain.runId,
        publishUncertain.token,
        'issue:summary-comment'
      )
      await store.failPublicationStep(
        publishUncertain.runId,
        publishUncertain.token,
        'issue:summary-comment',
        { message: 'response lost' },
        { retry: true }
      )
    }
    await assert.rejects(
      store.requirePublicationStepClaim(
        publishUncertain.runId,
        publishUncertain.token,
        'issue:summary-comment'
      )
    )

    // publication: publishing -> disconnected when a reconciliation itself runs out of budget
    // without an answer. The step is what becomes disconnected; the axis follows it.
    const publishDisconnected = await newPublishingRun()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.requirePublicationStepClaim(
        publishDisconnected.runId,
        publishDisconnected.token,
        'issue:summary-comment'
      )
      await store.failPublicationStep(
        publishDisconnected.runId,
        publishDisconnected.token,
        'issue:summary-comment',
        { message: 'response lost' },
        { retry: true }
      )
    }
    await assert.rejects(
      store.requirePublicationStepClaim(
        publishDisconnected.runId,
        publishDisconnected.token,
        'issue:summary-comment'
      )
    )
    // The step is now `uncertain`, waiting on a reconciliation. Three reconciliation rounds that
    // cannot reach the remote system spend its own budget, after which it stops answering for
    // itself and asks a person to look.
    assert.strictEqual(
      (await store.getRun(publishDisconnected.runId))?.publication.status,
      'uncertain',
      'an exhausted step makes the axis uncertain before its reconciliation runs'
    )
    for (let round = 0; round < 3; round += 1) {
      await store.failPublicationStep(
        publishDisconnected.runId,
        publishDisconnected.token,
        'issue:summary-comment',
        { code: 'RECONCILIATION_UNREACHABLE', message: 'could not look' },
        { retry: true }
      )
    }
    assert.strictEqual(
      (await store.getRun(publishDisconnected.runId))?.publication.status,
      'disconnected',
      'the axis has to follow its step into disconnected'
    )

    // publication: uncertain -> publishing when the reconciliation settles the step. The axis
    // returns to publishing because the publisher still owns the claim and continues with the
    // remaining steps. A separate run drives it: the one above already went on to `disconnected`,
    // and this edge is about a single step that resolves.
    const publishSettled = await newPublishingRun()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.requirePublicationStepClaim(
        publishSettled.runId,
        publishSettled.token,
        'issue:summary-comment'
      )
      await store.failPublicationStep(
        publishSettled.runId,
        publishSettled.token,
        'issue:summary-comment',
        { message: 'response lost' },
        { retry: true }
      )
    }
    await assert.rejects(
      store.requirePublicationStepClaim(
        publishSettled.runId,
        publishSettled.token,
        'issue:summary-comment'
      )
    )
    await store.settleExhaustedPublicationStep(
      publishSettled.runId,
      publishSettled.token,
      'issue:summary-comment',
      { found: true, remote: { id: '9', url: 'https://example.test/c/9' } }
    )
    assert.strictEqual(
      (await store.getRun(publishSettled.runId))?.publication.status,
      'publishing',
      'a settled step hands the axis back to its publisher'
    )

    // publication: publishing -> pending on a retryable failure.
    const publishRetried = await newPublishingRun()
    await store.failPublication(
      publishRetried.runId,
      publishRetried.token,
      { code: 'GITHUB_RATE_LIMITED', message: 'slow down' },
      { retry: true }
    )

    // publication: publishing -> skipped when the run is concluded while a publication is in
    // flight. There is no public "abandon a publication" call - the abandonment is part of
    // concluding the run - so this drives the preparation failure that performs it.
    const abandonedInFlight = await newPreparingRun()
    await pool.query(
      `UPDATE publications SET status='publishing', claim_token=$2,
         claimed_at=clock_timestamp(), started_at=clock_timestamp() WHERE run_id=$1`,
      [abandonedInFlight.runId, randomUUID()]
    )
    // Concluding the run converges the in-flight publication to `skipped`.
    await store.failPreparation(
      abandonedInFlight.runId,
      abandonedInFlight.token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' },
      { retry: false }
    )

    // preparation: preparing -> failed through the operator's abandon decision, which requires
    // the run to be in the blocked state first. That state is produced by an expiry that cannot
    // conclude, so it is arranged through the pool rather than through a store call: no public
    // path may create it, which is the point of the queue.
    const blocked = await newPreparingRun()
    await pool.query(
      `UPDATE preparations SET attempt_count=8,
         claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [blocked.runId]
    )
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{"keep":true}'::jsonb
       WHERE run_id=$1`,
      [blocked.runId]
    )
    assert.strictEqual(
      (await store.expireStalePreparations()).blocked.length,
      1
    )

    // preparation: disconnected -> uncertain when an operator hands the row back to automatic
    // recovery. A second run is arranged for it so the abandonment below still starts from a
    // disconnected row and keeps producing disconnected -> failed.
    const resumed = await newPreparingRun()
    await pool.query(
      `UPDATE preparations SET attempt_count=8,
         claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [resumed.runId]
    )
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{}'::jsonb WHERE run_id=$1`,
      [resumed.runId]
    )
    assert.strictEqual(
      (await store.expireStalePreparations()).blocked.length,
      1
    )
    await store.resumeDisconnectedPreparation(resumed.runId)

    // preparation: disconnected -> failed when an operator gives up on it, which is the plain
    // case (an expired lease that ran out its budget) rather than a contradicted run.
    const givenUpPreparation = await newPreparingRun()
    await pool.query(
      `UPDATE preparations SET attempt_count=8,
         claimed_at=clock_timestamp()-interval '1 hour' WHERE run_id=$1`,
      [givenUpPreparation.runId]
    )
    // Execution stays `pending`: a preparation only expires (and so can only disconnect) while
    // its execution has not advanced. The expiry itself is not what this records - the operator's
    // decision on the resulting row is - so the row is put in that state directly.
    await pool.query(
      `UPDATE preparations SET status='disconnected',
         disconnect_reason='EXECUTION_ALREADY_ADVANCED', claim_token=NULL, claimed_at=NULL,
         started_at=COALESCE(started_at, clock_timestamp()),
         finished_at=NULL WHERE run_id=$1`,
      [givenUpPreparation.runId]
    )
    await store.giveUpDisconnectedRun(
      givenUpPreparation.runId,
      'operator stopped waiting'
    )

    // publication: disconnected -> failed when an operator stops publishing. The step may
    // already have taken effect remotely, so the axis fails instead of being skipped.
    const givenUpPublication = await newPreparingRun()
    await pool.query(
      `UPDATE preparations SET status='submitted', claim_token=NULL, claimed_at=NULL,
         finished_at=clock_timestamp() WHERE run_id=$1`,
      [givenUpPublication.runId]
    )
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{}'::jsonb WHERE run_id=$1`,
      [givenUpPublication.runId]
    )
    const publicationToken = await store.claimPublication(
      givenUpPublication.runId
    )
    await store.initializePublicationSteps(
      givenUpPublication.runId,
      publicationToken as string,
      ['issue:summary-comment']
    )
    await store.requirePublicationStepClaim(
      givenUpPublication.runId,
      publicationToken as string,
      'issue:summary-comment'
    )
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await store.failPublicationStep(
        givenUpPublication.runId,
        publicationToken as string,
        'issue:summary-comment',
        { code: 'GITHUB_TIMEOUT', message: 'no answer' },
        { retry: true }
      )
      const status = (
        (await store.listPublicationSteps(givenUpPublication.runId))[0] as {
          status: string
        }
      ).status
      if (status === 'disconnected') break
      await store
        .requirePublicationStepClaim(
          givenUpPublication.runId,
          publicationToken as string,
          'issue:summary-comment'
        )
        .catch(() => undefined)
    }
    await store.giveUpDisconnectedRun(
      givenUpPublication.runId,
      'operator stopped publishing'
    )

    // publication: disconnected -> uncertain when an operator hands a parked publication back.
    // The steps return to `uncertain` with a fresh reconciliation budget, so the axis follows
    // them; the attempt budget stays spent, which is what keeps the side effect from running
    // again.
    const resumedPublication = await newPreparingRun()
    await pool.query(
      `UPDATE preparations SET status='submitted', claim_token=NULL, claimed_at=NULL,
         finished_at=clock_timestamp() WHERE run_id=$1`,
      [resumedPublication.runId]
    )
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{}'::jsonb WHERE run_id=$1`,
      [resumedPublication.runId]
    )
    const parkedToken = await store.claimPublication(resumedPublication.runId)
    await store.initializePublicationSteps(
      resumedPublication.runId,
      parkedToken as string,
      ['issue:summary-comment']
    )
    // `initializePublicationSteps` claims the first attempt, so each round reports an unanswered
    // call and then claims the next attempt. The step becomes `uncertain` once its attempts are
    // spent, and a later reconciliation failure is what parks it.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await store.failPublicationStep(
        resumedPublication.runId,
        parkedToken as string,
        'issue:summary-comment',
        { code: 'GITHUB_TIMEOUT', message: 'no answer' },
        { retry: true }
      )
      if (
        (await store.getRun(resumedPublication.runId))?.publication.status ===
        'disconnected'
      )
        break
      await store
        .requirePublicationStepClaim(
          resumedPublication.runId,
          parkedToken as string,
          'issue:summary-comment'
        )
        .catch(() => undefined)
    }
    assert.strictEqual(
      (await store.getRun(resumedPublication.runId))?.publication.status,
      'disconnected',
      'the resume below has to start from a parked publication'
    )
    await store.resumeDisconnectedRun(resumedPublication.runId)
    assert.strictEqual(
      (await store.getRun(resumedPublication.runId))?.publication.status,
      'uncertain'
    )
    assert.strictEqual(
      (await store.getRun(blocked.runId))?.preparation?.status,
      'disconnected',
      'the abandonment below has to start from a disconnected row'
    )

    await store.abandonBlockedPreparation(blocked.runId, 'operator decision')

    const recorded: RecordedEdge[] = []
    for (const runId of runIds) {
      for (const event of await store.listEvents(runId)) {
        if (event.from_status === null) continue
        recorded.push({
          axis: event.axis,
          edge: `${event.from_status}->${event.to_status}`,
          reason: event.reason_code
        })
      }
    }
    return recorded
  } finally {
    await pool.end()
    await store.close()
  }
}

test('every transition a run records is declared in the contract', async () => {
  const recorded = await recordEveryPath()
  const declared = new Map(
    STATE_MACHINES.map((machine) => [machine.axis, declaredEdges(machine.axis)])
  )
  for (const { axis, edge } of recorded) {
    assert.ok(
      declared.get(axis)?.has(edge),
      `${axis} recorded ${edge}, which the contract does not declare`
    )
  }
})

test('every declared edge is reachable by a write path', async () => {
  // The other direction, driven rather than copied: a declared edge that no write path produces
  // is a diagram claim nothing backs, and the driver above is the evidence that each one is
  // real. When a transition is renamed in the contract, this fails until a path produces the
  // new name, instead of silently agreeing with a stale list.
  const recorded = await recordEveryPath()
  const observed = new Map<string, Set<string>>()
  for (const { axis, edge } of recorded) {
    const edges = observed.get(axis) ?? new Set<string>()
    edges.add(edge)
    observed.set(axis, edges)
  }
  for (const machine of STATE_MACHINES) {
    for (const edge of declaredEdges(machine.axis)) {
      assert.ok(
        observed.get(machine.axis)?.has(edge),
        `${machine.axis} declares ${edge}, but no write path produces it`
      )
    }
  }
})

/** The reasons each declared edge promises, keyed by `axis from->to`.
 *
 * One pair of states can be written by more than one decision: a disconnected preparation is
 * abandoned when it contradicts execution, and given up on when an operator simply stops
 * waiting. Both are `disconnected -> failed`, and both carry a reason naming which decision
 * happened, so the contract declares them as separate edges and this collects the whole set.
 * A `null` entry means the edge deliberately accepts any reason (a connector-supplied code). */
function declaredReasons(): Map<string, Array<string | null>> {
  const reasons = new Map<string, Array<string | null>>()
  for (const machine of STATE_MACHINES) {
    for (const edge of machine.transitions) {
      const key = `${machine.axis} ${edge.from}->${edge.to}`
      const existing = reasons.get(key) ?? []
      existing.push(edge.reason ?? null)
      reasons.set(key, existing)
    }
  }
  return reasons
}

test('a reason the audit log writes is the reason the contract declares', async () => {
  // An edge's `reason` is a promise: "this transition is recorded with this code". The edge
  // comparison above looks only at `from->to`, so a write path could attach a different code
  // and nothing would notice. Edges the contract leaves without a reason are exempt: their
  // code is an open set owned by the connector, not a contract value.
  const recorded = await recordEveryPath()
  const declared = declaredReasons()
  for (const { axis, edge, reason } of recorded) {
    const key = `${axis} ${edge}`
    const expected = declared.get(key)
    assert.ok(expected !== undefined, `${key} is not declared`)
    // An edge that accepts any reason makes the whole pair open.
    if (expected.some((value) => value === null)) continue
    assert.ok(
      expected.includes(reason),
      `${key} was recorded with ${String(reason)} but the contract declares ${expected.join(' or ')}`
    )
  }
})
