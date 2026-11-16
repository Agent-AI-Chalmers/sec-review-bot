import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import type { PullRequestReviewInput } from '../src/execution-api-types-generated.js'
import { TemporalExecutionClient } from '../src/temporal-execution-client.js'
import { REPOSITORY_ROOT } from './project-paths.js'

function clientFor(
  value: unknown,
  onStart = () => {},
): TemporalExecutionClient {
  // Exercise the actual client methods with an in-process Temporal transport.
  return Reflect.construct(TemporalExecutionClient, [
    {},
    {
      workflow: {
        getHandle: () => ({
          describe: () =>
            Promise.resolve({
              status: 'COMPLETED',
              memo: { workflow: 'issue-review' },
            }),
          result: () => Promise.resolve(value),
        }),
        start: () => {
          onStart()
          return Promise.resolve()
        },
      },
    },
    'test',
  ]) as TemporalExecutionClient
}

const result = JSON.parse(
  readFileSync(
    path.join(
      REPOSITORY_ROOT,
      'contracts/execution-api/v1/fixtures/issue-review-result.json',
    ),
    'utf8',
  ),
) as unknown
const artifact_storage = {
  status: 'available',
  artifact: {
    kind: 'execution_archive',
    uri: 's3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    media_type: 'application/tar+zstd',
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42,
  },
}

for (const value of [
  null,
  undefined,
  [],
  'invalid',
  42,
  {},
  { ok: true, result: {} },
]) {
  await test(`invalid Temporal response becomes a failed run: ${JSON.stringify(value)}`, async () => {
    const record = await clientFor(value).get('run-1')
    assert.equal(record?.status, 'failed')
    assert.equal(record?.error?.code, 'EXECUTION_RESPONSE_INVALID')
  })
}

await test('validated completed Temporal result retains its public fields', async () => {
  const value = {
    ok: true,
    result,
    artifact_storage,
    memory_processing: { extractions: [] },
  }
  assert.deepEqual(await clientFor(value).get('run-1'), {
    run_id: 'run-1',
    workflow: 'issue-review',
    status: 'succeeded',
    result,
    artifact_storage,
    memory_processing: { extractions: [] },
  })
})

await test('invalid archive makes a completed Temporal result fail', async () => {
  const record = await clientFor({
    ok: true,
    result,
    artifact_storage: { status: 'available' },
  }).get('run-1')
  assert.equal(record?.status, 'failed')
  assert.equal(record?.error?.code, 'EXECUTION_RESPONSE_INVALID')
  assert.equal(
    record?.artifact_storage?.error_code,
    'ARTIFACT_REFERENCE_INVALID',
  )
})

await test('coercible error categories are rejected before crossing HTTP', async () => {
  const record = await clientFor({
    ok: false,
    error: {
      category: ['runtime'],
      code: 'FAIL',
      message: 'failed',
      retryable: false,
    },
  }).get('run-1')
  assert.equal(record?.error?.code, 'EXECUTION_RESPONSE_INVALID')
})

await test('direct submission rejects input for a different workflow before starting Temporal', async () => {
  let starts = 0
  const input = JSON.parse(
    readFileSync(
      path.join(
        REPOSITORY_ROOT,
        'contracts/execution-api/v1/fixtures/pull-request-review-input.json',
      ),
      'utf8',
    ),
  ) as PullRequestReviewInput
  const client = clientFor(null, () => {
    starts++
  })
  const invalid = {
    workflow: 'issue-review' as const,
    run_id: 'run-1',
    input,
    timeout_seconds: 30,
  }
  await assert.rejects(
    // @ts-expect-error The client must reject this pairing statically and at runtime.
    client.start(invalid),
    /Execution input does not match API/,
  )
  assert.equal(starts, 0)
})

await test('unknown input cannot be submitted without validation', async () => {
  const input: unknown = 42
  const invalid = {
    workflow: 'issue-review' as const,
    run_id: 'run-1',
    input,
    timeout_seconds: 30,
  }
  await assert.rejects(
    // @ts-expect-error Unvalidated input is not an internal submission.
    clientFor(null).start(invalid),
    /Execution Workflow input does not match/,
  )
})
