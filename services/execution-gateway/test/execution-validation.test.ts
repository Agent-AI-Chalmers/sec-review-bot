import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import {
  isExecutionError,
  validateExecutionInput,
  validateExecutionResult
} from '../src/execution-api-validation.js'
import { EXECUTION_API_VERSION } from '../src/execution-api-version.js'
import {
  executionWorkflowType,
  validateExecutionSubmission,
  validateExecutionWorkflowInput
} from '../src/execution-workflow-validation.js'

import { REPOSITORY_ROOT as REPO_ROOT } from './project-paths.js'

function contractFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        'contracts',
        'execution-api',
        EXECUTION_API_VERSION,
        'fixtures',
        name
      ),
      'utf8'
    )
  )
}

const EXECUTION_WORKFLOW_FIXTURES_ROOT = path.join(
  REPO_ROOT,
  'contracts',
  'execution-workflow',
  'v1',
  'fixtures'
)

function executionWorkflowFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(EXECUTION_WORKFLOW_FIXTURES_ROOT, name), 'utf8')
  )
}

interface ExecutionWorkflowFixtureManifest {
  valid: string[]
  invalid: string[]
}

function executionWorkflowFixtureManifest(): ExecutionWorkflowFixtureManifest {
  return executionWorkflowFixture(
    'manifest.json'
  ) as ExecutionWorkflowFixtureManifest
}

test('execution workflow shared fixtures match Gateway validation', () => {
  const manifest = executionWorkflowFixtureManifest()
  const declared = new Set([...manifest.valid, ...manifest.invalid])
  const actual = new Set(
    readdirSync(EXECUTION_WORKFLOW_FIXTURES_ROOT).filter(
      (name) => name.endsWith('.json') && name !== 'manifest.json'
    )
  )

  expect(declared).toStrictEqual(actual)
  expect(manifest.valid.some((name) => manifest.invalid.includes(name))).toBe(
    false
  )
  for (const name of manifest.valid) {
    expect(() =>
      validateExecutionWorkflowInput(executionWorkflowFixture(name))
    ).not.toThrow()
  }
  for (const name of manifest.invalid) {
    expect(() =>
      validateExecutionWorkflowInput(executionWorkflowFixture(name))
    ).toThrow(/execution-workflow\/v1/)
  }
})

test('execution workflow input owns the Temporal workflow type', () => {
  expect(executionWorkflowType()).toBe('execution-workflow')
  expect(() =>
    validateExecutionWorkflowInput({
      workflow: 'issue-review',
      run_id: 'run-contract',
      input: {},
      timeout_seconds: 60
    })
  ).not.toThrow()
  expect(() =>
    validateExecutionWorkflowInput({
      workflow: 'issue-review',
      run_id: 'invalid run id',
      input: {},
      timeout_seconds: 60
    })
  ).toThrow(/execution-workflow\/v1/)
})

test('execution workflow input rejects runtime overrides', () => {
  const request = {
    workflow: 'issue-review',
    run_id: 'run-runtime-contract',
    input: {},
    timeout_seconds: 60
  }
  for (const runtime of [
    null,
    {},
    { workspace_image: 'benchmark:latest' },
    'image',
    []
  ]) {
    expect(() =>
      validateExecutionWorkflowInput({ ...request, runtime })
    ).toThrow(/Execution Workflow input does not match/)
  }
})

test('execution errors match the public envelope before crossing HTTP', () => {
  expect(
    isExecutionError({
      category: 'runtime',
      code: 'EXECUTION_FAILED',
      message: 'failed',
      retryable: false,
      details: {}
    })
  ).toBe(true)
  expect(
    isExecutionError({ code: 'EXECUTION_FAILED', message: 'failed' })
  ).toBe(false)
})

test('the generated API version selects input and result schemas', () => {
  expect(() =>
    validateExecutionInput(
      'issue-review',
      contractFixture('issue-review-input.json')
    )
  ).not.toThrow()
  expect(() =>
    validateExecutionResult(
      'repository-review',
      contractFixture('repository-review-result.json')
    )
  ).not.toThrow()
})

test('contract schemas resolve independently of the process working directory', async () => {
  const original = process.cwd()
  const other = await mkdtemp(path.join(tmpdir(), 'gateway-cwd-'))
  try {
    process.chdir(other)
    expect(executionWorkflowType()).toBe('execution-workflow')
  } finally {
    process.chdir(original)
    await rm(other, { recursive: true, force: true })
  }
})

for (const [workflow, fixture] of [
  ['issue-review', 'issue-review-input.json'],
  ['pull-request-review', 'pull-request-review-input.json'],
  ['repository-review', 'repository-review-input-full.json']
] as const) {
  test(`complete submission validates and narrows ${workflow}`, () => {
    const submission: unknown = {
      workflow,
      input: contractFixture(fixture),
      run_id: 'run-1',
      timeout_seconds: 30
    }
    validateExecutionSubmission(submission)
    switch (submission.workflow) {
      case 'issue-review':
        expect(typeof submission.input.issue.number).toBe('number')
        break
      case 'pull-request-review':
        expect(typeof submission.input.pr.number).toBe('number')
        break
      case 'repository-review':
        expect.assert(submission.input.scan_target)
        break
    }
  })
}
