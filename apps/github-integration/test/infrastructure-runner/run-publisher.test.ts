import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from 'octokit'

import { contractFixture } from '../contract-fixtures.js'
import { appWithInstallationOctokit } from '../github-app-stubs.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../infrastructure/runner/publish-error-code.js'
import { DeterministicRunnerPublishError } from '../../infrastructure/runner/publish-error.js'
import {
  classifyRunnerPublishFailure,
  publishRunnerRunsOnce,
  shouldRetryRunnerPublishFailure
} from '../../infrastructure/runner/run-publisher.js'
import { RunnerRunStore } from '../../infrastructure/runner/run-store.js'
import type { RunnerRunStatus, WorkflowName } from '../../infrastructure/runner/client.js'

type PublishContext = Record<string, unknown>

function createStore (): RunnerRunStore {
  return new RunnerRunStore(':memory:')
}

function appStub (): App {
  return {} as unknown as App
}

function transientIssueCommentFailureOctokit (): unknown {
  return {
    rest: {
      issues: {
        createComment: async () => {
          throw new Error('GitHub API unavailable.')
        }
      }
    }
  }
}

function githubResponseError (status: number, message = 'GitHub API error.', headers: Record<string, unknown> = {}): Error {
  const error = new Error(message)
  Object.assign(error, {
    response: {
      status,
      headers,
      data: {
        message,
        errors: []
      }
    }
  })
  return error
}

function issueCommentFailureOctokit (error: Error): unknown {
  return {
    rest: {
      issues: {
        createComment: async () => {
          throw error
        }
      }
    }
  }
}

function succeededStatus (workflow: WorkflowName, result: unknown): RunnerRunStatus {
  return {
    run_id: 'run-1',
    workflow,
    status: 'succeeded',
    result
  }
}

function publishContextForWorkflow (workflow: WorkflowName): PublishContext {
  if (workflow === 'issue-review') {
    return {
      issue: {
        issue_number: 7,
        issue_title: 'Example issue',
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example'
      },
      workspace_ref: 'workspace-sha',
      event_type: 'manual_review'
    }
  }

  if (workflow === 'pull-request-review') {
    return {
      pr: { repo_full_name: 'octo/example' },
      files: [],
      event_type: 'manual_review'
    }
  }

  return {
    repo: { repo_full_name: 'octo/example' },
    workspace_ref: 'workspace-sha',
    scan_target: {
      target_branch: 'main',
      default_branch: 'main',
      event_type: 'manual',
      scan_mode: 'full',
      base_sha: null,
      head_sha: 'head-sha',
      commit_shas: []
    },
    event_type: 'manual'
  }
}

test('runner publisher does not retry deterministic publish validation failures', () => {
  assert.equal(
    shouldRetryRunnerPublishFailure(new DeterministicRunnerPublishError(
      'Repository review result is invalid.',
      RUNNER_PUBLISH_ERROR_CODES.repository_result_invalid
    )),
    false
  )
})

test('runner publisher only treats named deterministic errors with codes as non-retryable', () => {
  assert.equal(
    shouldRetryRunnerPublishFailure({ name: 'DeterministicRunnerPublishError' }),
    true
  )
  assert.equal(
    shouldRetryRunnerPublishFailure({
      name: 'DeterministicRunnerPublishError',
      code: 'RESULT_INVALID'
    }),
    false
  )
})

test('runner publisher keeps retrying generic publish failures', () => {
  assert.equal(shouldRetryRunnerPublishFailure(new Error('GitHub API unavailable.')), true)
})

test('runner publisher does not retry completed runner service failures', () => {
  const error = Object.assign(new Error('Agent runner failed.'), {
    name: 'AgentRunnerServiceError',
    code: 'RUNNER_FAILED'
  })

  assert.equal(shouldRetryRunnerPublishFailure(error), false)
})

test('runner publisher classifies GitHub publish failures by retryability', () => {
  const cases: Array<{
    name: string
    error: Error
    retry: boolean
    code: string | null
    reason: string
  }> = [
    {
      name: 'validation rejection',
      error: githubResponseError(422, 'Validation Failed'),
      retry: false,
      code: RUNNER_PUBLISH_ERROR_CODES.github_validation_rejected,
      reason: 'github-validation-rejected'
    },
    {
      name: 'auth rejection',
      error: githubResponseError(401, 'Bad credentials'),
      retry: false,
      code: RUNNER_PUBLISH_ERROR_CODES.github_auth_rejected,
      reason: 'github-auth-rejected'
    },
    {
      name: 'not found',
      error: githubResponseError(404, 'Not Found'),
      retry: false,
      code: RUNNER_PUBLISH_ERROR_CODES.github_not_found,
      reason: 'github-not-found'
    },
    {
      name: 'server error',
      error: githubResponseError(500, 'GitHub unavailable'),
      retry: true,
      code: null,
      reason: 'github-transient-response'
    },
    {
      name: 'too many requests',
      error: githubResponseError(429, 'Too many requests'),
      retry: true,
      code: null,
      reason: 'github-transient-response'
    },
    {
      name: 'secondary rate limit',
      error: githubResponseError(403, 'You have exceeded a secondary rate limit', {
        'retry-after': '60'
      }),
      retry: true,
      code: null,
      reason: 'github-rate-limited'
    }
  ]

  for (const item of cases) {
    assert.deepEqual(
      classifyRunnerPublishFailure(item.error),
      {
        retry: item.retry,
        code: item.code,
        reason: item.reason
      },
      item.name
    )
  }
})

test('runner publisher marks malformed issue results failed without retry', async () => {
  const store = createStore()
  store.save_queued_run({
    workflow: 'issue-review',
    run_id: 'run-1',
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishRunnerRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => succeededStatus('issue-review', {
      contract_version: 'v4',
      review_record: {}
    })
  })

  const run = store.getRun('run-1')
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.issue_result_invalid)
  assert.match(run?.failure_message ?? '', /Issue review result is invalid/)
  assert.equal(store.listActiveRuns().length, 0)
})

test('runner publisher marks malformed pull request results failed without retry', async () => {
  const store = createStore()
  store.save_queued_run({
    workflow: 'pull-request-review',
    run_id: 'run-1',
    publish_context: publishContextForWorkflow('pull-request-review')
  })

  await publishRunnerRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => succeededStatus('pull-request-review', {
      contract_version: 'v4',
      review_record: {}
    })
  })

  const run = store.getRun('run-1')
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.pull_request_result_invalid)
  assert.match(run?.failure_message ?? '', /Pull request review result is invalid/)
  assert.equal(store.listActiveRuns().length, 0)
})

test('runner publisher marks malformed repository results failed without retry', async () => {
  const store = createStore()
  store.save_queued_run({
    workflow: 'repository-review',
    run_id: 'run-1',
    publish_context: publishContextForWorkflow('repository-review')
  })

  await publishRunnerRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => succeededStatus('repository-review', {
      contract_version: 'v4',
      scan_summary: {},
      deliveries: [],
      case_results: [{ case_id: 'case-1' }]
    })
  })

  const run = store.getRun('run-1')
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.repository_result_invalid)
  assert.match(run?.failure_message ?? '', /Repository review result is invalid/)
  assert.equal(store.listActiveRuns().length, 0)
})

test('runner publisher keeps transient publish failures retryable in the store', async () => {
  const store = createStore()
  store.save_queued_run({
    workflow: 'issue-review',
    run_id: 'run-1',
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishRunnerRunsOnce({
    app: appWithInstallationOctokit({
      installation_octokit: transientIssueCommentFailureOctokit(),
      expected_owner: 'octo',
      expected_repo: 'example'
    }),
    store,
    get_runner_run_status: async () => succeededStatus(
      'issue-review',
      contractFixture('v4', 'issue-review-result.json')
    )
  })

  const run = store.getRun('run-1')
  assert.equal(run?.status, 'publish_failed')
  assert.equal(run?.publish_attempts, 1)
  assert.equal(store.listActiveRuns()[0]?.run_id, 'run-1')
})

test('runner publisher marks deterministic GitHub publish rejections failed without retry', async () => {
  const store = createStore()
  store.save_queued_run({
    workflow: 'issue-review',
    run_id: 'run-1',
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishRunnerRunsOnce({
    app: appWithInstallationOctokit({
      installation_octokit: issueCommentFailureOctokit(githubResponseError(422, 'Validation Failed')),
      expected_owner: 'octo',
      expected_repo: 'example'
    }),
    store,
    get_runner_run_status: async () => succeededStatus(
      'issue-review',
      contractFixture('v4', 'issue-review-result.json')
    )
  })

  const run = store.getRun('run-1')
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.github_validation_rejected)
  assert.equal(store.listActiveRuns().length, 0)
})
