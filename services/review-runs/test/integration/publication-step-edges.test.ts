// The contract's `publication_step` machine claims to describe how a step's status moves. Step
// transitions are not written to the run event log, so the audit-log comparison in
// state-machine-edges.test.ts cannot check them. This test drives the real store write paths
// instead and observes each step row before and after every call, in both directions:
//
//   - an edge a write path produces but the contract omits means the diagram is wrong;
//   - an edge the contract declares but no write path produces means the diagram promises
//     behaviour nothing backs.
//
// A row change with an unchanged status (a takeover, an inconclusive reconciliation) counts as a
// self-loop only when its attempt or reconciliation counter moved, so a refused call that
// changes nothing is never recorded as an edge.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { Pool } from 'pg'

import { STATE_MACHINES } from '../../src/state-machines.generated.js'
import { ReviewRunStore } from '../../src/persistence/review-run-store.js'

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

const STEP = 'issue:summary-comment'

interface StepRow {
  status: string
  attempt_count: number
  recovery_attempt_count: number
}

function declaredStepEdges(): Set<string> {
  const machine = STATE_MACHINES.find(
    (candidate) => candidate.axis === 'publication_step'
  )
  assert.ok(machine, 'the contract declares a publication_step machine')
  return new Set(machine.transitions.map((edge) => `${edge.from}->${edge.to}`))
}

/** Drive every store path that moves a publication step, and return the edges it produced. */
async function recordEveryStepPath(): Promise<Set<string>> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: `step-edges:${randomUUID()}`,
    claimTimeoutMs: 60_000
  })
  await store.initialize()
  const pool = new Pool({ connectionString: requireTestDatabase() })
  const recorded = new Set<string>()

  const readStep = async (runId: string): Promise<StepRow> => {
    const result = await pool.query<StepRow>(
      `SELECT status, attempt_count, recovery_attempt_count FROM publication_steps
       WHERE run_id=$1 AND step_key=$2`,
      [runId, STEP]
    )
    const row = result.rows[0]
    assert.ok(row, `run ${runId} has a ${STEP} step`)
    return row
  }

  /** Run one write and record the step edge it produced, if any. Refusals are expected on some
   * paths (an exhausted claim throws after moving the step), so errors are swallowed and the
   * row itself is the evidence. */
  const observe = async (
    runId: string,
    write: () => Promise<unknown>
  ): Promise<void> => {
    const before = await readStep(runId)
    await write().catch(() => undefined)
    const after = await readStep(runId)
    const moved =
      before.status !== after.status ||
      before.attempt_count !== after.attempt_count ||
      before.recovery_attempt_count !== after.recovery_attempt_count
    if (moved) recorded.add(`${before.status}->${after.status}`)
  }

  const newPublishingRun = async (): Promise<{
    runId: string
    token: string
  }> => {
    const runId = `run-${randomUUID()}`
    const admission = await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.submissionTransitions.markQueued(
      runId,
      admission.preparation_token,
      {}
    )
    assert.ok(
      await store.executions.recordExecutionSuccess(
        runId,
        { run_id: runId },
        { status: 'unavailable' }
      )
    )
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token)
    await store.publications.initializePublicationSteps(runId, token, [STEP])
    return { runId, token }
  }

  const claimStep = (runId: string, token: string) => () =>
    store.publications.requirePublicationStepClaim(runId, token, STEP)
  const failStep =
    (runId: string, token: string, retry: boolean | undefined) => () =>
      store.publications.failPublicationStep(
        runId,
        token,
        STEP,
        { code: 'GITHUB_TIMEOUT', message: 'no answer' },
        retry === undefined ? {} : { retry }
      )

  /** Spend the attempt budget with retryable failures, leaving the step `failed` on its last
   * attempt, then let the refused claim send it to reconciliation. */
  const exhaustThroughFailed = async (runId: string, token: string) => {
    for (;;) {
      await observe(runId, claimStep(runId, token))
      const step = await readStep(runId)
      if (step.status !== 'running') break
      await observe(runId, failStep(runId, token, true))
    }
    assert.strictEqual((await readStep(runId)).status, 'uncertain')
  }

  try {
    // pending -> running -> succeeded.
    const written = await newPublishingRun()
    await observe(written.runId, claimStep(written.runId, written.token))
    await observe(written.runId, () =>
      store.publications.completePublicationStep(
        written.runId,
        written.token,
        STEP,
        { id: '1' }
      )
    )

    // running -> failed -> running -> terminal_failed.
    const terminal = await newPublishingRun()
    await observe(terminal.runId, claimStep(terminal.runId, terminal.token))
    await observe(
      terminal.runId,
      failStep(terminal.runId, terminal.token, true)
    )
    await observe(terminal.runId, claimStep(terminal.runId, terminal.token))
    await observe(
      terminal.runId,
      failStep(terminal.runId, terminal.token, false)
    )

    // running -> running: an expired publication lease lets a new owner take over the step.
    const takenOver = await newPublishingRun()
    await observe(takenOver.runId, claimStep(takenOver.runId, takenOver.token))
    await pool.query(
      `UPDATE publications SET claimed_at=clock_timestamp()-interval '1 hour'
       WHERE run_id=$1`,
      [takenOver.runId]
    )
    const newOwner = await store.publicationClaims.claim(takenOver.runId)
    assert.ok(newOwner)
    await observe(takenOver.runId, claimStep(takenOver.runId, newOwner))

    // failed -> uncertain -> succeeded: reconciliation found the side effect.
    const found = await newPublishingRun()
    await exhaustThroughFailed(found.runId, found.token)
    await observe(found.runId, () =>
      store.publications.settleExhaustedPublicationStep(
        found.runId,
        found.token,
        STEP,
        { found: true, remote: { id: '1' } }
      )
    )

    // running -> uncertain -> terminal_failed: the last attempt never reported, and
    // reconciliation confirmed the side effect is absent.
    const absent = await newPublishingRun()
    for (;;) {
      await observe(absent.runId, claimStep(absent.runId, absent.token))
      const step = await readStep(absent.runId)
      if (step.status !== 'running' || step.attempt_count >= 3) break
      await observe(absent.runId, failStep(absent.runId, absent.token, true))
    }
    await observe(absent.runId, claimStep(absent.runId, absent.token))
    assert.strictEqual((await readStep(absent.runId)).status, 'uncertain')
    await observe(absent.runId, () =>
      store.publications.settleExhaustedPublicationStep(
        absent.runId,
        absent.token,
        STEP,
        { found: false }
      )
    )

    // uncertain -> failed, then back to uncertain on the next refused claim.
    const plain = await newPublishingRun()
    await exhaustThroughFailed(plain.runId, plain.token)
    await observe(plain.runId, failStep(plain.runId, plain.token, undefined))
    await observe(plain.runId, claimStep(plain.runId, plain.token))

    // uncertain -> terminal_failed: a terminal failure reported while reconciling.
    const terminalWhileReconciling = await newPublishingRun()
    await exhaustThroughFailed(
      terminalWhileReconciling.runId,
      terminalWhileReconciling.token
    )
    await observe(
      terminalWhileReconciling.runId,
      failStep(
        terminalWhileReconciling.runId,
        terminalWhileReconciling.token,
        false
      )
    )

    // uncertain -> uncertain -> disconnected -> pending: reconciliation runs out of budget and
    // an operator returns the step to the queue.
    const parked = await newPublishingRun()
    await exhaustThroughFailed(parked.runId, parked.token)
    for (let round = 0; round < 10; round += 1) {
      await observe(parked.runId, failStep(parked.runId, parked.token, true))
      if ((await readStep(parked.runId)).status === 'disconnected') break
    }
    assert.strictEqual((await readStep(parked.runId)).status, 'disconnected')
    await observe(parked.runId, () =>
      store.operatorDecisions.resumeDisconnectedRun(parked.runId)
    )

    return recorded
  } finally {
    await pool.end()
    await store.close()
  }
}

let recordedPaths: Promise<Set<string>> | undefined

function recordEveryStepPathOnce(): Promise<Set<string>> {
  recordedPaths ??= recordEveryStepPath()
  return recordedPaths
}

test('every publication step transition a write path produces is declared in the contract', async () => {
  const recorded = await recordEveryStepPathOnce()
  const declared = declaredStepEdges()
  for (const edge of recorded)
    assert.ok(
      declared.has(edge),
      `publication_step produced ${edge}, which the contract does not declare`
    )
})

test('every declared publication step edge is produced by a write path', async () => {
  const recorded = await recordEveryStepPathOnce()
  for (const edge of declaredStepEdges())
    assert.ok(
      recorded.has(edge),
      `publication_step declares ${edge}, but no write path produces it`
    )
})
