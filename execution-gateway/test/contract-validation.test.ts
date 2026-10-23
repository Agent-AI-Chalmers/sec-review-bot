import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  executionWorkflowType,
  isExecutionError,
  validateExecutionInput,
  validateExecutionRequest,
  validateExecutionResult,
} from '../src/contract-validation.js'
import { WORKFLOW_CONTRACT_VERSION } from '../src/contract-version.js'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

function contractFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        'contracts',
        'integration-contract',
        WORKFLOW_CONTRACT_VERSION,
        'fixtures',
        name,
      ),
      'utf8',
    ),
  )
}

await test('execution contract owns the Temporal workflow type and envelope', () => {
  assert.equal(executionWorkflowType(), 'execution-workflow')
  assert.doesNotThrow(() =>
    validateExecutionRequest({
      workflow: 'issue-review',
      run_id: 'run-contract',
      input_data: {},
      timeout_seconds: 60,
    }),
  )
  assert.throws(
    () =>
      validateExecutionRequest({
        workflow: 'issue-review',
        run_id: 'invalid run id',
        input_data: {},
        timeout_seconds: 60,
      }),
    /execution-contract\/v1/,
  )
})

await test('execution runtime accepts only the declared override shape', () => {
  const request = {
    workflow: 'issue-review',
    run_id: 'run-runtime-contract',
    input_data: {},
    timeout_seconds: 60,
  }

  assert.doesNotThrow(() => validateExecutionRequest(request))
  assert.doesNotThrow(() =>
    validateExecutionRequest({ ...request, runtime: null }),
  )
  assert.doesNotThrow(() =>
    validateExecutionRequest({
      ...request,
      runtime: { workspace_image: 'benchmark:latest' },
    }),
  )
  for (const runtime of [
    'benchmark:latest',
    [],
    { workspace_image: '   ' },
    { unknown: true },
  ]) {
    assert.throws(
      () => validateExecutionRequest({ ...request, runtime }),
      /execution-contract\/v1/,
    )
  }
})

await test('execution errors match the public envelope before crossing HTTP', () => {
  assert.equal(
    isExecutionError({
      category: 'runtime',
      code: 'EXECUTION_FAILED',
      message: 'failed',
      retryable: false,
      details: {},
    }),
    true,
  )
  assert.equal(
    isExecutionError({ code: 'EXECUTION_FAILED', message: 'failed' }),
    false,
  )
})

await test('the generated contract version selects input and result schemas', () => {
  assert.doesNotThrow(() =>
    validateExecutionInput(
      'issue-review',
      contractFixture('issue-review-input.json'),
    ),
  )
  assert.doesNotThrow(() =>
    validateExecutionResult(
      'repository-review',
      contractFixture('repository-review-result.json'),
    ),
  )
})

await test('contract schemas resolve independently of the process working directory', async () => {
  const original = process.cwd()
  const other = await mkdtemp(path.join(tmpdir(), 'gateway-cwd-'))
  try {
    process.chdir(other)
    assert.equal(executionWorkflowType(), 'execution-workflow')
  } finally {
    process.chdir(original)
    await rm(other, { recursive: true, force: true })
  }
})
