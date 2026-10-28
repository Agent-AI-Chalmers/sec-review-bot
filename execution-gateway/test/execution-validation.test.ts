import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  isExecutionError,
  validateExecutionInput,
  validateExecutionResult,
} from '../src/execution-api-validation.js'
import { EXECUTION_API_VERSION } from '../src/execution-api-version.js'
import {
  executionWorkflowType,
  validateExecutionWorkflowInput,
} from '../src/execution-workflow-validation.js'

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
        'execution-api',
        EXECUTION_API_VERSION,
        'fixtures',
        name,
      ),
      'utf8',
    ),
  )
}

const EXECUTION_WORKFLOW_FIXTURES_ROOT = path.join(
  REPO_ROOT,
  'contracts',
  'execution-workflow',
  'v1',
  'fixtures',
)

function executionWorkflowFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(EXECUTION_WORKFLOW_FIXTURES_ROOT, name), 'utf8'),
  )
}

interface ExecutionWorkflowFixtureManifest {
  valid: string[]
  invalid: string[]
}

function executionWorkflowFixtureManifest(): ExecutionWorkflowFixtureManifest {
  return executionWorkflowFixture(
    'manifest.json',
  ) as ExecutionWorkflowFixtureManifest
}

await test('execution workflow shared fixtures match Gateway validation', () => {
  const manifest = executionWorkflowFixtureManifest()
  const declared = new Set([...manifest.valid, ...manifest.invalid])
  const actual = new Set(
    readdirSync(EXECUTION_WORKFLOW_FIXTURES_ROOT).filter(
      (name) => name.endsWith('.json') && name !== 'manifest.json',
    ),
  )

  assert.deepEqual(declared, actual)
  assert.equal(
    manifest.valid.some((name) => manifest.invalid.includes(name)),
    false,
  )
  for (const name of manifest.valid) {
    assert.doesNotThrow(() =>
      validateExecutionWorkflowInput(executionWorkflowFixture(name)),
    )
  }
  for (const name of manifest.invalid) {
    assert.throws(
      () => validateExecutionWorkflowInput(executionWorkflowFixture(name)),
      /execution-workflow\/v1/,
    )
  }
})

await test('execution workflow input owns the Temporal workflow type', () => {
  assert.equal(executionWorkflowType(), 'execution-workflow')
  assert.doesNotThrow(() =>
    validateExecutionWorkflowInput({
      workflow: 'issue-review',
      run_id: 'run-contract',
      input: {},
      timeout_seconds: 60,
    }),
  )
  assert.throws(
    () =>
      validateExecutionWorkflowInput({
        workflow: 'issue-review',
        run_id: 'invalid run id',
        input: {},
        timeout_seconds: 60,
      }),
    /execution-workflow\/v1/,
  )
})

await test('execution workflow input accepts only the declared runtime override shape', () => {
  const request = {
    workflow: 'issue-review',
    run_id: 'run-runtime-contract',
    input: {},
    timeout_seconds: 60,
  }

  assert.doesNotThrow(() => validateExecutionWorkflowInput(request))
  assert.doesNotThrow(() =>
    validateExecutionWorkflowInput({ ...request, runtime: null }),
  )
  assert.doesNotThrow(() =>
    validateExecutionWorkflowInput({
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
      () => validateExecutionWorkflowInput({ ...request, runtime }),
      /execution-workflow\/v1/,
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

await test('the generated API version selects input and result schemas', () => {
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
