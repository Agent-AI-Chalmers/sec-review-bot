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
 * `claimNextRunFailureNotice` is a queue, not a lookup: other runs' notices queued earlier would
 * otherwise be claimed here and left dangling, which is exactly how an earlier version of this
 * driver failed to exercise `delivering -> failed` while appearing to.
 */
async function claimNoticeFor(
  store: ReviewRunStore,
  runId: string
): Promise<{ claim_token: string }> {
  const deferred: Array<{ run_id: string; claim_token: string }> = []
  const deadline = Date.now() + 5_000
  try {
    while (Date.now() < deadline) {
      const notice = await store.claimNextRunFailureNotice()
      if (notice === null) break
      if (notice.run_id === runId) return { claim_token: notice.claim_token }
      deferred.push({
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
      await store.completeRunFailureNotice(
        other.run_id,
        other.claim_token,
        false
      )
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
    const preparedNotice = await store.claimNextRunFailureNotice()
    assert.notStrictEqual(preparedNotice, null)
    await store.completeRunFailureNotice(
      failedPreparation.runId,
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
    assert.notStrictEqual(await store.claimNextRunFailureNotice(), null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.notStrictEqual(await store.claimNextRunFailureNotice(), null)

    // notice: delivering -> failed when the provider cannot be reached.
    const undeliverable = await newPreparingRun()
    await store.failPreparation(
      undeliverable.runId,
      undeliverable.token,
      { code: 'PREPARATION_RETRY_EXHAUSTED', message: 'exhausted' },
      { retry: false }
    )
    const undeliverableNotice = await claimNoticeFor(store, undeliverable.runId)
    await store.completeRunFailureNotice(
      undeliverable.runId,
      undeliverableNotice.claim_token,
      false
    )

    // preparation: preparing -> pending when a lease expires without exhausting retries, then
    // pending -> preparing when the next preparer claims it. Both halves matter: the second is
    // the only path that returns a run to active preparation after a failure.
    await newPreparingRun()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const expiry = await store.expireStalePreparations()
    assert.ok(expiry.concluded >= 1)
    const reclaimed = await store.claimNextPreparation()
    assert.notStrictEqual(reclaimed, null)

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

/** The fixed reason a declared edge promises, keyed by `axis from->to`, or null when the edge
 * deliberately accepts any reason (a connector-supplied error code). */
function declaredReasons(): Map<string, string | null> {
  const reasons = new Map<string, string | null>()
  for (const machine of STATE_MACHINES) {
    for (const edge of machine.transitions) {
      reasons.set(
        `${machine.axis} ${edge.from}->${edge.to}`,
        edge.reason ?? null
      )
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
    assert.ok(declared.has(key), `${key} is not declared`)
    const expected = declared.get(key)
    if (expected === null || expected === undefined) continue
    assert.strictEqual(
      reason,
      expected,
      `${key} was recorded with ${String(reason)} but the contract declares ${expected}`
    )
  }
})
