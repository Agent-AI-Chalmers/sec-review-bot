// Drive production submission, Gateway and terminal coordination; the Python test runs the worker.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { createApp } from '../../services/execution-gateway/dist/server.js'
import { TemporalExecutionClient } from '../../services/execution-gateway/dist/temporal-execution-client.js'
import { ReviewRunStore } from '../../services/review-runs/dist/persistence/review-run-store.js'
import {
  submitExecutionRun,
  getExecutionRunStatus
} from '../../services/review-runs/dist/execution-client.js'
import { observeExecutionRun } from '../../services/review-runs/dist/runtime/terminal-coordination.js'

const request = JSON.parse(
  await readFile(process.env.TEST_REQUEST_FILE, 'utf8')
)
const connectorId = 'lifecycle'
const store = new ReviewRunStore({
  connectionString: process.env.TEST_DATABASE_URL,
  connectorId
})
const executionClient = await TemporalExecutionClient.connect()
const app = await createApp({
  client: executionClient,
  token: 'seam-execution'
})
let storeClosed = false
try {
  await store.initialize()
  process.env.EXECUTION_API_URL = await app.listen({
    host: '127.0.0.1',
    port: 0
  })
  const admitted = await store.admissions.create({
    workflow: 'issue-review',
    run_id: request.run_id,
    publish_context: {},
    preparation_input_version: 'v1',
    preparation_input: { kind: 'seam' }
  })
  const token = admitted.preparation_token
  assert(token)
  const intent = {
    reference: request.input.input_bundle,
    input: request.input,
    publish_context: {}
  }
  await store.inputBundleCandidates.reserve(request.run_id, token, intent)
  // publish-input.mjs already uploaded these bytes before this driver started.
  await store.inputBundleCandidates.settle(
    request.run_id,
    token,
    intent.reference.digest,
    'present'
  )
  await store.submissionTransitions.savePreparedSubmission(
    request.run_id,
    token,
    {},
    request.input
  )
  await submitExecutionRun(request)
  // An uncertain acknowledgement must resolve to the same Temporal execution.
  await submitExecutionRun(request)
  await store.submissionTransitions.markQueued(request.run_id, token, {})
  const deadline = Date.now() + 60_000
  let record
  while (Date.now() < deadline) {
    record = await store.queries.getRun(request.run_id)
    const status = await observeExecutionRun(
      store,
      record,
      getExecutionRunStatus,
      () => false
    )
    if (status === 'succeeded' || status === 'failed') break
    await setTimeout(100)
  }
  assert.equal(record?.run_id, request.run_id)
  // Reopen the database owner: success must be durable, not merely an HTTP response.
  await store.close()
  storeClosed = true
  const reopened = new ReviewRunStore({
    connectionString: process.env.TEST_DATABASE_URL,
    connectorId
  })
  try {
    await reopened.initialize()
    record = await reopened.queries.getRun(request.run_id)
    assert.equal(
      record.execution.status,
      'succeeded',
      JSON.stringify(record.execution)
    )
    // The ordinary run projection omits workflow_result. Claiming publication
    // checks the actual consumer boundary and proves the result is publishable.
    const publication = await reopened.publicationClaims.claimNext()
    assert.equal(publication?.run_id, request.run_id)
    assert.equal(publication.workflow_result.api_version, 'v1')
    assert.equal(publication.artifact_storage.status, 'available')
    assert.equal(await reopened.publicationClaims.claimNext(), null)
    await writeFile(process.env.TEST_RESULT_FILE, JSON.stringify(publication))
  } finally {
    await reopened.close()
  }
} finally {
  await app.close()
  await executionClient.close()
  if (!storeClosed) await store.close()
}
