import { REPOSITORY_ROOT as repositoryDirectory } from '../project-paths.js'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'

import { ExecutionRunConflictError, type ExecutionWorkflowInput } from '../../src/execution.js'
import type { IssueReviewInput } from '../../src/execution-api-types-generated.js'
import { TemporalExecutionClient } from '../../src/temporal-execution-client.js'

const temporalAddress = process.env.TEST_TEMPORAL_ADDRESS
if (temporalAddress === undefined)
  throw new Error('TEST_TEMPORAL_ADDRESS is required for integration tests.')

async function issueReviewInput(): Promise<IssueReviewInput> {
  return JSON.parse(
    await readFile(
      path.join(
        repositoryDirectory,
        'contracts',
        'execution-api',
        'v1',
        'fixtures',
        'issue-review-input.json'
      ),
      'utf8'
    )
  ) as IssueReviewInput
}

test('Temporal client submits and identifies execution requests', async () => {
  process.env.TEMPORAL_ADDRESS = temporalAddress
  const client = await TemporalExecutionClient.connect()
  const runId = `gateway-integration-${crypto.randomUUID()}`
  const request: ExecutionWorkflowInput = {
    workflow: 'issue-review',
    run_id: runId,
    input: await issueReviewInput(),
    timeout_seconds: 60
  }

  try {
    const created = await client.start(request)
    expect(created.run_id).toBe(runId)
    expect(created.workflow).toBe(request.workflow)
    expect(created.status).toBe('running')

    expect(await client.start(request)).toStrictEqual(created)
    expect(await client.get(runId)).toStrictEqual(created)
    expect(await client.get(`missing-${crypto.randomUUID()}`)).toBe(undefined)

    expect(
      await client.start({ ...request, timeout_seconds: 120 }),
      'Gateway timeout policy is not part of the caller request identity'
    ).toStrictEqual(created)

    await expect(
      client.start({
        ...request,
        input: {
          ...request.input,
          setup_declaration: 'steps:\n  - run: echo changed\n'
        }
      })
    ).rejects.toThrow(ExecutionRunConflictError)
  } finally {
    await client.close()
  }
})
