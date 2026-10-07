import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { App } from 'octokit'

import { appWithInstallationOctokit } from '../../../github-app-stubs.js'
import { RepositoryReviewDispatchValidationError } from '../../../../src/triggers/repository-review.js'

process.env.APP_ID = process.env.APP_ID || '123456'
process.env.PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || '/dev/null'
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'webhook-test-secret'

function oidcRequest(payload: Record<string, unknown>, token = 'test-oidc-token'): IncomingMessage {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const request = Readable.from([body]) as IncomingMessage
  request.method = 'POST'
  request.headers = {
    'x-sec-review-bot-oidc-token': token
  }
  return request
}

function oidcVerifier(claims: Record<string, unknown> = {}) {
  return async () => ({
    repository: 'octo/example',
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    workflow_ref: 'octo/example/.github/workflows/sec-review-bot.yml@refs/heads/main',
    ...claims
  })
}

function captureResponse(): ServerResponse & { statusCodeValue?: number; body?: string } {
  const response: {
    statusCodeValue?: number
    body?: string
    writeHead: (status_code: number) => unknown
    end: (body: string) => unknown
  } = {
    writeHead(status_code: number) {
      this.statusCodeValue = status_code
      return this
    },
    end(body: string) {
      this.body = body
      return this
    }
  }
  return response as ServerResponse & { statusCodeValue?: number; body?: string }
}

function fakeApp(): App {
  return appWithInstallationOctokit({
    installation_octokit: {
      rest: {
        repos: {
          getBranch: async () => ({
            data: {
              commit: {
                sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
              }
            }
          }),
          getCommit: async ({ ref }: { ref: string }) => ({
            data: {
              sha: String(ref)
            }
          })
        }
      }
    },
    expected_owner: 'octo',
    expected_repo: 'example'
  })
}

test('repository dispatch forwards repair_mode to repository review submission', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const calls: Array<{ repair_mode: string | null }> = []
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual',
      repair_mode: 'no-test-changes'
    }),
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async ({ payload }) => {
      calls.push({ repair_mode: String(payload.repair_mode ?? '') || null })
      return {
        run_id: 'run-1',
        replayed: false
      }
    }
  })

  assert.equal(response.statusCodeValue, 202)
  assert.deepEqual(calls, [{ repair_mode: 'no-test-changes' }])
})

test('repository dispatch returns preparing as soon as durable admission completes', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()
  let finishExecution: (() => void) | undefined

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-immediate'
    }),
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async ({ on_admitted: onAdmitted }) => {
      onAdmitted?.({ run_id: 'run-immediate', status: 'preparing', replayed: false })
      await new Promise<void>((resolve) => {
        finishExecution = resolve
      })
      throw new Error('execution failed after admission')
    }
  })

  assert.equal(response.statusCodeValue, 202)
  assert.deepEqual(JSON.parse(response.body ?? '{}'), {
    ok: true,
    accepted: true,
    status: 'preparing',
    replayed: false,
    run_id: 'run-immediate',
    repo_full_name: 'octo/example',
    summary_issue_url: null
  })
  finishExecution?.()
})

test('repository dispatch requires a correlation id before starting a review', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main'
    }),
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async () => assert.fail('invalid dispatch must not start a review')
  })

  assert.equal(response.statusCodeValue, 400)
  assert.match(String(response.body), /correlation_id is required/)
})

test('repository dispatch rejects manual incremental without base_sha as a bad request', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'incremental',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async () => {
      throw new RepositoryReviewDispatchValidationError(
        'manual incremental scan requires base_sha.'
      )
    }
  })

  assert.equal(response.statusCodeValue, 400)
  assert.match(String(response.body), /manual incremental scan requires base_sha/)
})

test('repository dispatch does not echo internal submission errors', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async () => {
      throw new Error('sensitive runner failure detail')
    }
  })

  assert.equal(response.statusCodeValue, 500)
  assert.match(String(response.body), /Repository review dispatch failed/)
  assert.doesNotMatch(String(response.body), /sensitive runner failure detail/)
})

test('repository dispatch rejects oversized request bodies before authentication', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const body = Buffer.alloc(1_048_577, 'x')
  const request = Readable.from([body]) as IncomingMessage
  request.method = 'POST'
  request.headers = {
    'x-sec-review-bot-oidc-token': 'test-oidc-token'
  }
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request,
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 413)
  assert.match(String(response.body), /too large/)
})

test('repository dispatch rejects missing OIDC token', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const request = oidcRequest({
    repo_full_name: 'octo/example',
    target_branch: 'main',
    correlation_id: 'actions-run-1',
    scan_mode: 'full',
    event_type: 'manual'
  })
  request.headers = {}
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request,
    response,
    oidcVerifier: oidcVerifier(),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 401)
  assert.match(String(response.body), /Missing GitHub Actions OIDC token/)
})

test('repository dispatch rejects OIDC repository mismatch', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier({
      repository: 'octo/other'
    }),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 403)
  assert.match(String(response.body), /repository does not match/)
})

test('repository dispatch passes the canonical OIDC repository to admission', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()
  let verifiedRepository: string | undefined

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'Octo/Example',
      target_branch: 'main',
      correlation_id: 'actions-canonical-1'
    }),
    response,
    oidcVerifier: oidcVerifier({
      repository: 'OCTO/EXAMPLE',
      workflow_ref: 'OCTO/EXAMPLE/.github/workflows/sec-review-bot.yml@refs/heads/main'
    }),
    dispatchReview: async ({ verified_repository: repository }) => {
      verifiedRepository = repository
      return { run_id: 'run-canonical', replayed: false }
    }
  })

  assert.equal(response.statusCodeValue, 202)
  assert.equal(verifiedRepository, 'octo/example')
})

test('repository dispatch rejects disallowed OIDC event', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier({
      event_name: 'pull_request'
    }),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 403)
  assert.match(String(response.body), /event is not allowed/)
})

test('repository dispatch rejects OIDC ref mismatch', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier({
      ref: 'refs/heads/dev'
    }),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 403)
  assert.match(String(response.body), /ref does not match/)
})

test('repository dispatch rejects disallowed OIDC workflow', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier({
      workflow_ref: 'octo/example/.github/workflows/other.yml@refs/heads/main'
    }),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 403)
  assert.match(String(response.body), /workflow is not allowed/)
})

test('repository dispatch does not accept job_workflow_ref as the dispatch workflow', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier({
      workflow_ref: 'octo/example/.github/workflows/other.yml@refs/heads/main',
      job_workflow_ref: 'octo/example/.github/workflows/sec-review-bot.yml@refs/heads/main'
    }),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 403)
  assert.match(String(response.body), /workflow is not allowed/)
})

test('repository dispatch rejects OIDC workflow from a different branch', async () => {
  const { handleRepositoryReviewDispatch } =
    await import('../../../../src/interfaces/github/actions/repository-review-http-handler.js')
  const response = captureResponse()

  await handleRepositoryReviewDispatch({
    app: fakeApp(),
    request: oidcRequest({
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-1',
      scan_mode: 'full',
      event_type: 'manual'
    }),
    response,
    oidcVerifier: oidcVerifier({
      workflow_ref: 'octo/example/.github/workflows/sec-review-bot.yml@refs/heads/dev'
    }),
    dispatchReview: async () => {
      throw new Error('dispatchReview should not be called')
    }
  })

  assert.equal(response.statusCodeValue, 403)
  assert.match(String(response.body), /workflow is not allowed/)
})
