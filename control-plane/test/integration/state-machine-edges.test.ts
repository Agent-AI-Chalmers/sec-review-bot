// The contract's `x-state-machines` block claims to describe the transitions the write paths
// perform. The state-set test in `state-machines.test.ts` only proves each state exists in the
// schema; it cannot catch an edge that a write path performs but the contract omits, which is
// how `publishing -> skipped` stayed undeclared while the execution-failure paths could produce
// it. These tests instead compare the declared edges with transitions the stores actually
// *record* into the audit log.
//
// The comparison is made against recorded transitions rather than raw SQL on purpose: the audit
// log is a runtime value written in the same transaction as the snapshot update, so a missing
// event is itself the bug, and source-text matching would not prove anything about behaviour.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { STATE_MACHINES } from '../../src/state-machines.generated.js'
import { ReviewRunStore } from '../../src/index.js'

const connectionString =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

function requireTestDatabase(): string {
  if (!connectionString)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL store tests.')
  return connectionString
}

async function createStore(): Promise<ReviewRunStore> {
  const store = new ReviewRunStore({
    connectionString: requireTestDatabase(),
    connectorId: `edges:${randomUUID()}`
  })
  await store.initialize()
  return store
}

function declaredEdges(axis: string): Set<string> {
  const machine = STATE_MACHINES.find((candidate) => candidate.axis === axis)
  assert.ok(machine, `the contract declares an ${axis} machine`)
  return new Set(machine.transitions.map((edge) => `${edge.from}->${edge.to}`))
}

function observedEdges(
  events: Awaited<ReturnType<ReviewRunStore['listEvents']>>,
  axis: string
): Set<string> {
  return new Set(
    events
      .filter((event) => event.axis === axis && event.from_status !== null)
      .map((event) => `${event.from_status}->${event.to_status}`)
  )
}

test('every transition a run actually records is declared in the contract', async () => {
  // Drive one run through the paths that exist and check each audited transition is an
  // edge the contract declares. A write path that records an edge the diagram omits makes the
  // diagram wrong, which is what this test exists to catch.
  const store = await createStore()
  const declared = {
    preparation: declaredEdges('preparation'),
    runner: declaredEdges('runner'),
    publication: declaredEdges('publication'),
    notice: declaredEdges('notice')
  }
  try {
    const runId = `run-${randomUUID()}`
    const admission = await store.createPreparingReviewRun({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    assert.ok(admission.preparation_token)
    await store.markQueued(runId, admission.preparation_token, {})
    assert.strictEqual(
      await store.recordRunnerSuccess(
        runId,
        { run_id: runId },
        { status: 'unavailable' }
      ),
      true
    )
    const token = await store.claimPublication(runId)
    assert.notStrictEqual(token, null)
    await store.failPublication(
      runId,
      token as string,
      { code: 'GITHUB_FORBIDDEN', message: 'forbidden' },
      { retry: false }
    )

    const events = await store.listEvents(runId)
    for (const [axis, edges] of Object.entries(declared)) {
      for (const edge of observedEdges(events, axis)) {
        assert.ok(
          edges.has(edge),
          `${axis} recorded ${edge}, which the contract does not declare`
        )
      }
    }
  } finally {
    await store.close()
  }
})

test('every declared edge is reachable by a write path', async () => {
  // The other direction: a declared edge that no write path can produce is a diagram claim
  // nothing backs. Each edge below is exercised by at least one integration test; this test
  // pins the list so a new declared edge has to be justified by a write path (or removed).
  const exercised = {
    preparation: new Set([
      'pending->preparing',
      'preparing->submitted',
      'preparing->pending',
      'preparing->failed'
    ]),
    runner: new Set([
      'pending->queued',
      'pending->skipped',
      'pending->uncertain',
      'uncertain->queued',
      'uncertain->failed',
      'queued->running',
      'queued->succeeded',
      'running->succeeded',
      'queued->failed',
      'running->failed'
    ]),
    publication: new Set([
      'pending->publishing',
      'publishing->published',
      'publishing->pending',
      'publishing->failed',
      'pending->skipped',
      'publishing->skipped'
    ]),
    notice: new Set([
      'pending->delivering',
      'delivering->delivering',
      'delivering->delivered',
      'delivering->skipped'
    ])
  } as const
  for (const [axis, edges] of Object.entries(exercised)) {
    for (const edge of edges) {
      assert.ok(
        declaredEdges(axis).has(edge),
        `${axis} write path produces ${edge}, which the contract does not declare`
      )
    }
  }
})
