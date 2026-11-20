import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'
import { ExecutionRunConflictError, type ExecutionWorkflowInput } from '../src/execution.js'

import type {
  IssueReviewInput,
  PullRequestReviewInput
} from '../src/execution-api-types.generated.js'
import { TemporalExecutionClient } from '../src/temporal-execution-client.js'
import { REPOSITORY_ROOT } from './project-paths.js'

function clientFor(value: unknown, onStart = () => {}): TemporalExecutionClient {
  // Exercise the actual client methods with an in-process Temporal transport.
  return Reflect.construct(TemporalExecutionClient, [
    {},
    {
      workflow: {
        getHandle: () => ({
          describe: () =>
            Promise.resolve({
              status: 'COMPLETED',
              memo: { workflow: 'issue-review' }
            }),
          result: () => Promise.resolve(value)
        }),
        start: () => {
          onStart()
          return Promise.resolve()
        }
      }
    },
    'test'
  ]) as TemporalExecutionClient
}

const result = JSON.parse(
  readFileSync(
    path.join(REPOSITORY_ROOT, 'contracts/execution-api/v1/fixtures/issue-review-result.json'),
    'utf8'
  )
) as unknown
const artifact_storage = {
  status: 'available',
  artifact: {
    kind: 'execution_archive',
    uri: 's3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    media_type: 'application/tar+zstd',
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42
  }
}

for (const value of [null, undefined, [], 'invalid', 42, {}, { ok: true, result: {} }]) {
  test(`invalid Temporal response becomes a failed run: ${JSON.stringify(value)}`, async () => {
    const record = await clientFor(value).get('run-1')
    expect(record?.status).toBe('failed')
    expect(record?.error?.code).toBe('EXECUTION_RESPONSE_INVALID')
  })
}

test('validated completed Temporal result retains its public fields', async () => {
  const value = {
    ok: true,
    result,
    artifact_storage,
    memory_processing: { extractions: [] }
  }
  expect(await clientFor(value).get('run-1')).toStrictEqual({
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'succeeded',
    result,
    artifact_storage,
    memory_processing: { extractions: [] }
  })
})

test('invalid archive makes a completed Temporal result fail', async () => {
  const record = await clientFor({
    ok: true,
    result,
    artifact_storage: { status: 'available' }
  }).get('run-1')
  expect(record?.status).toBe('failed')
  expect(record?.error?.code).toBe('EXECUTION_RESPONSE_INVALID')
  expect(record?.artifact_storage?.error_code).toBe('ARTIFACT_REFERENCE_INVALID')
})

test('coercible error categories are rejected before crossing HTTP', async () => {
  const record = await clientFor({
    ok: false,
    error: {
      category: ['runtime'],
      code: 'FAIL',
      message: 'failed',
      retryable: false
    }
  }).get('run-1')
  expect(record?.error?.code).toBe('EXECUTION_RESPONSE_INVALID')
})

test('direct submission rejects input for a different workflow before starting Temporal', async () => {
  let starts = 0
  const input = JSON.parse(
    readFileSync(
      path.join(
        REPOSITORY_ROOT,
        'contracts/execution-api/v1/fixtures/pull-request-review-input.json'
      ),
      'utf8'
    )
  ) as PullRequestReviewInput
  const client = clientFor(null, () => {
    starts++
  })
  const invalid = {
    workflow: 'issue-review' as const,
    run_id: 'run-1',
    input,
    timeout_seconds: 30
  }
  await expect(
    // @ts-expect-error The client must reject this pairing statically and at runtime.
    client.start(invalid)
  ).rejects.toThrow(/Execution input does not match API/)
  expect(starts).toBe(0)
})

test('unknown input cannot be submitted without validation', async () => {
  const input: unknown = 42
  const invalid = {
    workflow: 'issue-review' as const,
    run_id: 'run-1',
    input,
    timeout_seconds: 30
  }
  await expect(
    // @ts-expect-error Unvalidated input is not an internal submission.
    clientFor(null).start(invalid)
  ).rejects.toThrow(/Execution Workflow input does not match/)
})

function duplicateSubmission(matches: boolean) {
  const request: ExecutionWorkflowInput = {
    workflow: 'issue-review',
    run_id: 'run-1',
    input: JSON.parse(
      readFileSync(
        path.join(REPOSITORY_ROOT, 'contracts/execution-api/v1/fixtures/issue-review-input.json'),
        'utf8'
      )
    ) as IssueReviewInput,
    timeout_seconds: 30
  }
  let memo: Record<string, unknown> = {}
  const describe = vi.fn(() => Promise.resolve({ status: 'COMPLETED', memo }))
  const readResult = vi.fn(() => Promise.resolve({ ok: true, result, artifact_storage }))
  const client = Reflect.construct(TemporalExecutionClient, [
    {},
    {
      workflow: {
        start: (_type: string, options: { memo: Record<string, unknown> }) => {
          memo = { ...options.memo, ...(!matches ? { request_fingerprint: 'different' } : {}) }
          throw new WorkflowExecutionAlreadyStartedError('already started', 'run-1', 'test')
        },
        getHandle: () => ({ describe, result: readResult })
      }
    },
    'test'
  ]) as TemporalExecutionClient
  return { client, request, describe, readResult }
}

test('matching duplicate submission returns the completed result', async () => {
  const { client, request, describe, readResult } = duplicateSubmission(true)
  expect(await client.start(request)).toMatchObject({
    run_id: 'run-1',
    status: 'succeeded',
    result
  })
  expect(readResult).toHaveBeenCalledOnce()
  expect(describe).toHaveBeenCalledOnce()
})

test('conflicting duplicate submission rejects before reading the result', async () => {
  const { client, request, describe, readResult } = duplicateSubmission(false)
  await expect(client.start(request)).rejects.toBeInstanceOf(ExecutionRunConflictError)
  expect(readResult).not.toHaveBeenCalled()
  expect(describe).toHaveBeenCalledOnce()
})
