import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { App } from 'octokit'

import { contractFixture } from '../../contract-fixtures.js'
import { appWithInstallationOctokit } from '../../github-app-stubs.js'
import { RUNNER_PUBLISH_ERROR_CODES } from '../../../src/infrastructure/runner/publish-error-code.js'
import { DeterministicRunnerPublishError } from '../../../src/infrastructure/runner/publish-error.js'
import { publishReviewRunsOnce, startRunnerRunPublisher } from '../../../src/infrastructure/runner/run-publisher.js'
import { classifyPublicationFailure } from '../../../src/infrastructure/runner/publication-failure.js'
import { ReviewRunStore } from '../../../src/infrastructure/runner/review-store.js'
import { parsePublishContextForWorkflow } from '../../../src/infrastructure/runner/publish-context.js'
import { publishContextForWorkflow } from '../../publish-context-fixtures.js'
import {
  RUNNER_RUN_NOT_FOUND,
  RunnerSubmissionUncertainError,
  type RunnerRunStatus,
  type WorkflowName
} from '../../../src/infrastructure/runner/client.js'

async function createStore (options: { connectorId?: string, claimTimeoutMs?: number } = {}): Promise<ReviewRunStore> {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required for publisher store tests.')
  const store = new ReviewRunStore({
    connectionString,
    connectorId: options.connectorId ?? `publisher-test:${randomUUID()}`,
    ...(options.claimTimeoutMs === undefined ? {} : { claimTimeoutMs: options.claimTimeoutMs })
  })
  await store.initialize()
  return store
}

async function createQueuedRun (store: ReviewRunStore, run: Parameters<ReviewRunStore['create_preparing_review_run']>[0]): Promise<void> {
  const admission = await store.create_preparing_review_run(run)
  assert.ok(admission.preparation_token)
  await store.mark_queued(run.run_id, admission.preparation_token, parsePublishContextForWorkflow(run.workflow, run.publish_context))
}

async function createUncertainRun (store: ReviewRunStore): Promise<string> {
  const runId = `run-uncertain-${randomUUID()}`
  const admission = await store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })
  assert.ok(admission.preparation_token)
  await store.save_prepared_submission(
    runId,
    admission.preparation_token,
    publishContextForWorkflow('issue-review'),
    { contract_version: 'v5', issue: { number: 7 } }
  )
  await store.failPreparation(runId, admission.preparation_token, {
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'Runner response was lost.'
  })
  return runId
}

test('publisher retries an uncertain idempotent submission without another ingress delivery', async () => {
  const store = await createStore()
  const runId = await createUncertainRun(store)

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    submit_runner_run: async () => {
      throw new RunnerSubmissionUncertainError('Runner response was lost again.')
    }
  })

  assert.equal((await store.getRun(runId))?.status, 'failed')
  assert.equal((await store.getRun(runId))?.failure_code, 'SUBMISSION_STATE_UNCERTAIN')
  assert.equal((await store.listSubmissionRecoveries()).length, 1)
  await store.close()
})

test('publisher replays the persisted idempotent submission directly', async () => {
  const store = await createStore()
  const runId = await createUncertainRun(store)
  const submissions: unknown[] = []

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => ({
      run_id: 'run-uncertain',
      workflow: 'issue-review',
      status: 'queued'
    }),
    submit_runner_run: async (request) => {
      submissions.push(request)
      return { run_id: request.run_id, workflow: request.workflow, status: 'queued' }
    }
  })

  assert.deepEqual(submissions, [{
    workflow: 'issue-review',
    run_id: runId,
    input: { contract_version: 'v5', issue: { number: 7 } }
  }])
  assert.equal((await store.getRun(runId))?.status, 'queued')
  await store.close()
})

test('stopping the runner publisher waits for its active publish pass', async () => {
  const store = await createStore()
  const runId = `run-shutdown-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })
  let releaseStatus: (() => void) | undefined
  const statusBlocked = new Promise<void>((resolve) => {
    releaseStatus = resolve
  })
  let statusRequested: (() => void) | undefined
  const statusRequestStarted = new Promise<void>((resolve) => {
    statusRequested = resolve
  })
  const publisher = startRunnerRunPublisher({
    app: appStub(),
    store,
    intervalMs: 60_000,
    get_runner_run_status: async () => {
      statusRequested?.()
      await statusBlocked
      return {
        run_id: runId,
        workflow: 'issue-review',
        status: 'running'
      }
    }
  })
  await statusRequestStarted

  let stopped = false
  const stopping = publisher.stop().then(() => {
    stopped = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)

  releaseStatus?.()
  await stopping
  assert.equal(stopped, true)
  await store.close()
})

function appStub (): App {
  return {} as unknown as App
}

function transientIssueCommentFailureOctokit (): unknown {
  return {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
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
        listComments: async () => ({ data: [] }),
        createComment: async () => {
          throw error
        }
      }
    }
  }
}

function succeededStatus (runId: string, workflow: WorkflowName, result: unknown): RunnerRunStatus {
  return {
    run_id: runId,
    workflow,
    status: 'succeeded',
    result
  }
}

test('runner publisher does not retry deterministic publish validation failures', () => {
  assert.equal(
    classifyPublicationFailure(new DeterministicRunnerPublishError(
      'Repository review result is invalid.',
      RUNNER_PUBLISH_ERROR_CODES.repository_result_invalid
    )).retry,
    false
  )
})

test('runner publisher only treats named deterministic errors with codes as non-retryable', () => {
  assert.equal(
    classifyPublicationFailure({ name: 'DeterministicRunnerPublishError' }).retry,
    true
  )
  assert.equal(
    classifyPublicationFailure({
      name: 'DeterministicRunnerPublishError',
      code: 'RESULT_INVALID'
    }).retry,
    false
  )
})

test('runner publisher keeps retrying generic publish failures', () => {
  assert.equal(classifyPublicationFailure(new Error('GitHub API unavailable.')).retry, true)
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
      classifyPublicationFailure(item.error),
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
  const store = await createStore()
  const runId = `run-malformed-issue-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => succeededStatus(runId, 'issue-review', {
      contract_version: 'v5',
      review_record: {}
    })
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.issue_result_invalid)
  assert.match(run?.failure_message ?? '', /Issue review result is invalid/)
  assert.equal((await store.listActiveRuns()).length, 0)
  await store.close()
})

test('runner publisher terminates a run when Runner no longer has its execution', async () => {
  const store = await createStore()
  const runId = `run-missing-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })
  let statusRequests = 0

  const publishOnce = async (): Promise<void> => publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => {
      statusRequests += 1
      throw Object.assign(new Error('Runner execution no longer exists.'), {
        name: 'AgentRunnerServiceError',
        code: RUNNER_RUN_NOT_FOUND,
        retryable: false
      })
    }
  })

  await publishOnce()

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_RUN_NOT_FOUND)
  assert.equal(statusRequests, 1)
  assert.equal((await store.listActiveRuns()).length, 0)
  await store.close()
})

test('runner publisher leaves a run active after a transient status polling failure', async () => {
  const store = await createStore()
  const runId = `run-poll-transient-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => {
      throw Object.assign(new Error('Runner service is temporarily unavailable.'), {
        name: 'AgentRunnerServiceError',
        code: 'RUNNER_SERVICE_UNAVAILABLE',
        retryable: true
      })
    }
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'queued')
  assert.equal(run?.failure_code, null)
  assert.equal((await store.listActiveRuns()).length, 1)
  await store.close()
})

test('runner publisher records terminal Runner failure before publication', async () => {
  const store = await createStore()
  const runId = `run-runner-failed-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => ({
      run_id: runId,
      workflow: 'issue-review',
      status: 'failed',
      error: {
        category: 'runtime',
        code: 'RUNNER_EXECUTION_FAILED',
        message: 'Agent execution failed.',
        retryable: false,
        details: {}
      }
    })
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, 'RUNNER_EXECUTION_FAILED')
  assert.equal(await store.claimPublication(runId), null)
  await store.close()
})

test('runner publisher marks malformed pull request results failed without retry', async () => {
  const store = await createStore()
  const runId = `run-malformed-pr-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'pull-request-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('pull-request-review')
  })

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => succeededStatus(runId, 'pull-request-review', {
      contract_version: 'v5',
      review_record: {}
    })
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.pull_request_result_invalid)
  assert.match(run?.failure_message ?? '', /Pull request review result is invalid/)
  assert.equal((await store.listActiveRuns()).length, 0)
  await store.close()
})

test('runner publisher marks malformed repository results failed without retry', async () => {
  const store = await createStore()
  const runId = `run-malformed-repository-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('repository-review')
  })

  await publishReviewRunsOnce({
    app: appStub(),
    store,
    get_runner_run_status: async () => succeededStatus(runId, 'repository-review', {
      contract_version: 'v5',
      scan_summary: {},
      deliveries: [],
      case_results: [{ case_id: 'case-1' }]
    })
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.repository_result_invalid)
  assert.match(run?.failure_message ?? '', /Repository review result is invalid/)
  assert.equal((await store.listActiveRuns()).length, 0)
  await store.close()
})

test('runner publisher keeps transient publish failures retryable in the store', async () => {
  const store = await createStore()
  const runId = `run-transient-publish-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishReviewRunsOnce({
    app: appWithInstallationOctokit({
      installation_octokit: transientIssueCommentFailureOctokit(),
      expected_owner: 'octo',
      expected_repo: 'example'
    }),
    store,
    get_runner_run_status: async () => succeededStatus(
      runId,
      'issue-review',
      contractFixture('v5', 'issue-review-result.json')
    )
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'queued')
  assert.equal((await store.listActiveRuns())[0]?.run_id, runId)
  await store.close()
})

test('runner publisher renews its claim while a GitHub side effect is in flight', async () => {
  const connectorId = `publisher-heartbeat:${randomUUID()}`
  const owner = await createStore({ connectorId, claimTimeoutMs: 150 })
  const contender = await createStore({ connectorId, claimTimeoutMs: 150 })
  const runId = `run-heartbeat-${randomUUID()}`
  await createQueuedRun(owner, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })
  let releaseComment: (() => void) | undefined
  const commentBlocked = new Promise<void>(resolve => { releaseComment = resolve })
  let commentStarted: (() => void) | undefined
  const commentStart = new Promise<void>(resolve => { commentStarted = resolve })
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => {
          commentStarted?.()
          await commentBlocked
          return { data: { id: 1, html_url: 'https://example.test/comment/1' } }
        }
      }
    }
  }

  try {
    const publishing = publishReviewRunsOnce({
      app: appWithInstallationOctokit({ installation_octokit: octokit }),
      store: owner,
      get_runner_run_status: async () => succeededStatus(
        runId,
        'issue-review',
        contractFixture('v5', 'issue-review-result.json')
      )
    })
    await commentStart
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(await contender.claimPublication(runId), null)
    releaseComment?.()
    await publishing
    assert.equal((await owner.getRun(runId))?.status, 'published')
  } finally {
    releaseComment?.()
    await Promise.all([owner.close(), contender.close()])
  }
})

test('runner publisher marks deterministic GitHub publish rejections failed without retry', async () => {
  const store = await createStore()
  const runId = `run-rejected-publish-${randomUUID()}`
  await createQueuedRun(store, {
    workflow: 'issue-review',
    run_id: runId,
    publish_context: publishContextForWorkflow('issue-review')
  })

  await publishReviewRunsOnce({
    app: appWithInstallationOctokit({
      installation_octokit: issueCommentFailureOctokit(githubResponseError(422, 'Validation Failed')),
      expected_owner: 'octo',
      expected_repo: 'example'
    }),
    store,
    get_runner_run_status: async () => succeededStatus(
      runId,
      'issue-review',
      contractFixture('v5', 'issue-review-result.json')
    )
  })

  const run = await store.getRun(runId)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failure_code, RUNNER_PUBLISH_ERROR_CODES.github_validation_rejected)
  assert.equal((await store.listActiveRuns()).length, 0)
  await store.close()
})
