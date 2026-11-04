import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  ExecutionRunConflictError,
  type ExecutionWorkflowInput,
} from '../../src/execution.js'
import type { IssueReviewInput } from '../../src/execution-api-types-generated.js'
import { TemporalExecutionClient } from '../../src/temporal-execution-client.js'

const temporalAddress = process.env.TEST_TEMPORAL_ADDRESS
if (temporalAddress === undefined)
  throw new Error('TEST_TEMPORAL_ADDRESS is required for integration tests.')

const repositoryDirectory = path.resolve(import.meta.dirname, '../../../..')

async function issueReviewInput(): Promise<IssueReviewInput> {
  return JSON.parse(
    await readFile(
      path.join(
        repositoryDirectory,
        'contracts',
        'execution-api',
        'v1',
        'fixtures',
        'issue-review-input.json',
      ),
      'utf8',
    ),
  ) as IssueReviewInput
}

await test('Temporal client submits and identifies execution requests', async () => {
  process.env.TEMPORAL_ADDRESS = temporalAddress
  const client = await TemporalExecutionClient.connect()
  const runId = `gateway-integration-${crypto.randomUUID()}`
  const request: ExecutionWorkflowInput = {
    workflow: 'issue-review',
    run_id: runId,
    input: await issueReviewInput(),
    timeout_seconds: 60,
  }

  try {
    const created = await client.start(request)
    assert.equal(created.run_id, runId)
    assert.equal(created.workflow, request.workflow)
    assert.equal(created.status, 'running')

    assert.deepEqual(await client.start(request), created)
    assert.deepEqual(await client.get(runId), created)
    assert.equal(await client.get(`missing-${crypto.randomUUID()}`), undefined)

    assert.deepEqual(
      await client.start({ ...request, timeout_seconds: 120 }),
      created,
      'Gateway timeout policy is not part of the caller request identity',
    )

    await assert.rejects(
      client.start({
        ...request,
        runtime: { workspace_image: 'example.invalid/changed:latest' },
      }),
      ExecutionRunConflictError,
    )
  } finally {
    await client.close()
  }
})
