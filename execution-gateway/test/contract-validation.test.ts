import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  executionWorkflowType,
  isExecutionError,
  validateExecutionRequest,
} from '../src/contract-validation.js'

void test('execution contract owns the Temporal workflow type and envelope', () => {
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

void test('execution errors match the public envelope before crossing HTTP', () => {
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

void test('contract schemas resolve independently of the process working directory', async () => {
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
