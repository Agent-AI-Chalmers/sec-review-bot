// Every timestamp on the read surface must leave the store as the contract's ISO date-time
// string. node-pg parses a bare timestamptz column into a Date, and Fastify's JSON serializer
// hides the difference on the wire, so a row type that claims `string` for such a column
// type-checks and passes HTTP tests while the in-process value is still a Date. This file reads
// each surface through the store itself and checks the runtime value, which is where that drift
// shows up.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

import { ReviewRunStore } from '../../src/persistence/review-run-store.js'

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required.')
  return value
}

function assertIsoTimestamp(value: unknown, field: string): void {
  assert.strictEqual(typeof value, 'string', `${field} must be a string`)
  assert.strictEqual(
    new Date(value as string).toISOString(),
    value,
    `${field} must be a canonical ISO date-time`
  )
}

function assertIsoTimestampOrNull(value: unknown, field: string): void {
  if (value !== null) assertIsoTimestamp(value, field)
}

test('store reads return contract timestamps as ISO strings, not Dates', async () => {
  const store = new ReviewRunStore({
    connectionString: databaseUrl(),
    connectorId: `read-timestamps:${randomUUID()}`,
    claimTimeoutMs: 0
  })
  await store.initialize()
  const pool = new Pool({ connectionString: databaseUrl() })
  const runId = `run-${randomUUID()}`
  const step = 'comment'
  try {
    await store.admissions.create({
      workflow: 'issue-review',
      run_id: runId,
      publish_context: {}
    })
    // Fill every nullable timestamp so the assertions below see a value, not just null.
    await pool.query(
      `UPDATE executions SET status='succeeded', started_at=clock_timestamp(),
         finished_at=clock_timestamp(), workflow_result='{}'::jsonb
       WHERE run_id=$1`,
      [runId]
    )
    const token = await store.publicationClaims.claim(runId)
    assert.ok(token, 'the run must be claimable for publication')
    await store.publications.initializePublicationSteps(runId, token, [step])
    await store.publications.requirePublicationStepClaim(runId, token, step)

    const run = await store.queries.getRun(runId)
    assert.ok(run)
    assertIsoTimestamp(run.created_at, 'run.created_at')
    for (const axis of ['preparation', 'execution', 'publication'] as const) {
      const axisRecord: {
        started_at: string | null
        finished_at: string | null
        updated_at: string
      } | null = run[axis]
      assert.ok(axisRecord, `${axis} axis must be present`)
      assertIsoTimestampOrNull(axisRecord.started_at, `${axis}.started_at`)
      assertIsoTimestampOrNull(axisRecord.finished_at, `${axis}.finished_at`)
      assertIsoTimestamp(axisRecord.updated_at, `${axis}.updated_at`)
    }
    assertIsoTimestamp(run.execution?.started_at, 'execution.started_at')
    assertIsoTimestamp(run.publication?.started_at, 'publication.started_at')

    const page = await store.queries.listRunsPage({ limit: 10 })
    const listed = page.runs.find((item) => item.run_id === runId)
    assert.ok(listed)
    assertIsoTimestamp(listed.created_at, 'listRunsPage.created_at')

    const events = await store.queries.listEvents(runId)
    assert.ok(events.length > 0)
    for (const event of events)
      assertIsoTimestamp(event.occurred_at, 'event.occurred_at')

    const [stepRecord] = await store.publications.listPublicationSteps(runId)
    assertIsoTimestamp(stepRecord?.last_attempt_at, 'step.last_attempt_at')

    await pool.query(
      `UPDATE publications SET status='disconnected' WHERE run_id=$1`,
      [runId]
    )
    const parked = await store.queries.listParkedRuns()
    const parkedRun = parked.find((item) => item.run_id === runId)
    assert.ok(parkedRun)
    assertIsoTimestamp(parkedRun.parked_at, 'parked_at')
  } finally {
    await pool.end()
    await store.close()
  }
})
