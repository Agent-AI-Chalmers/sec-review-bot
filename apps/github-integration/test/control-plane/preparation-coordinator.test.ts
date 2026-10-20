// Verifies recovery-only preparation inputs can deliver their terminal notice
// without a live webhook payload or a fully materialized pull-request context.
import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareReviewRunsOnce } from '../../src/control-plane/preparation-coordinator.js'
import { fakeApp } from '../github-app-stubs.js'
import { fakeGitHub, githubJson } from '../github-client.js'

test('terminal preparation notice reaches a pull request reconstructed from pr_reference', async () => {
  // A real App whose transport answers the installation lookup; the installation client it
  // hands back is a real Octokit over a second fake transport, so every GitHub call below is a
  // real request this test can assert on.
  const client = fakeGitHub(({ method, url }) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/comments') && method === 'GET')
      return githubJson([])
    if (pathname.endsWith('/comments'))
      return githubJson({ id: 9, html_url: 'https://example.test/comment/9' })
    return githubJson({ full_name: 'octo/example' })
  })
  const { app, requests } = fakeApp({
    respond: () => githubJson({ id: 42 }),
    installationOctokit: client.octokit
  })
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-pr-reference',
      input: {
        kind: 'github_pull_request_review',
        pr_reference: {
          owner_login: 'octo',
          repo_name: 'example',
          pr_number: 7
        }
      },
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app, store: store as never }),
    true
  )
  // The installation lookup is the only request the App itself makes.
  assert.strictEqual(requests.length, 1)
  assert.match(requests[0]!.url, /\/repos\/octo\/example\/installation$/)
  // The reply path then verifies the repository and posts the notice through the client.
  assert.deepStrictEqual(
    client.requests.map(
      (request) => `${request.method} ${new URL(request.url).pathname}`
    ),
    [
      'GET /repos/octo/example',
      'GET /repos/octo/example/issues/7/comments',
      'POST /repos/octo/example/issues/7/comments'
    ]
  )
  const posted = client.requests[2]!.body as { body: string }
  assert.match(posted.body, /run-pr-reference/)
  assert.deepStrictEqual(completed, [
    // The comment that was posted, so the console can link the requester to it.
    ['run-pr-reference', 'notice-token', true, 'https://example.test/comment/9']
  ])
})

test('preparation-first scheduling falls back to a terminal notice when no preparation is ready', async () => {
  const calls: string[] = []
  const store = {
    claimNextPreparation: async () => {
      calls.push('preparation')
      return null
    },
    claimNextRunFailureNotice: async () => {
      calls.push('notice')
      return {
        run_id: 'run-without-reply-target',
        input: {},
        failure_code: 'PREPARATION_RETRY_EXHAUSTED',
        claim_token: 'notice-claim'
      }
    },
    completeRunFailureNotice: async () => {
      calls.push('complete-notice')
      return true
    }
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({
      // Nothing here may reach GitHub: any request would surface as a recorded request.
      app: fakeApp().app,
      store: store as never,
      preferFailureNotice: false
    }),
    true
  )
  assert.deepStrictEqual(calls, ['preparation', 'notice', 'complete-notice'])
})

test('a repository scan failure reports into the repository summary issue', async () => {
  // A repository scan has no conversation to reply in: it is dispatched from GitHub Actions or
  // a schedule. Its success path reports into the repository's summary issue, so a failure has
  // to be readable in the same place; otherwise whoever started the scan sees nothing, and the
  // outcome exists only inside the Control Plane.
  const client = fakeGitHub(({ method, url }) => {
    const pathname = new URL(url).pathname
    // The summary issue already exists: the reply must comment on it, not create a new one.
    if (pathname.endsWith('/issues') && method === 'GET')
      return githubJson([
        {
          number: 77,
          title: '[sec-review-bot] Repository Security Review Summary'
        }
      ])
    if (pathname.endsWith('/comments') && method === 'GET')
      return githubJson([])
    if (pathname.endsWith('/comments') && method === 'POST')
      return githubJson({ id: 5, html_url: 'https://example.test/comment/5' })
    return githubJson({ full_name: 'octo/example' })
  })
  const { app } = fakeApp({
    respond: () => githubJson({ id: 42 }),
    installationOctokit: client.octokit
  })
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-repository',
      input: {
        kind: 'github_repository_review',
        payload: { repo_full_name: 'octo/example' },
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app, store: store as never }),
    true
  )
  const created = client.requests.find(
    (request) =>
      request.method === 'POST' &&
      new URL(request.url).pathname.endsWith('/comments')
  )
  assert.ok(created, 'the failure must be posted as a comment')
  const body = created.body as { body: string }
  assert.ok(
    new URL(created.url).pathname.includes('/issues/77/'),
    'it reports into the existing summary issue, not a new one'
  )
  assert.match(body.body, /run-repository/)
  assert.match(body.body, /PREPARATION_RETRY_EXHAUSTED/)
  assert.deepStrictEqual(completed, [
    ['run-repository', 'notice-token', true, 'https://example.test/comment/5']
  ])
})

test('an unrecoverable notice concludes instead of being retried forever', async () => {
  // A notice is re-claimed whenever its delivery lease expires, so a fault that retrying cannot
  // repair would otherwise be attempted again on every lease period, forever, while the
  // requester is never told and the run never settles. A 404 for the repository's installation is
  // exactly that: the App will never gain access by waiting. It must be concluded as undelivered
  // so the record reflects what happened.
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-unreachable-repository',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }
  // A 404 from the installation lookup is what GitHub answers for "this app is not installed";
  // retrying can never change it, so the notice must be concluded as undelivered.
  const { app } = fakeApp({
    respond: () => githubJson({ message: 'Not Found' }, 404)
  })

  assert.strictEqual(
    await prepareReviewRunsOnce({ app, store: store as never }),
    true
  )
  assert.deepStrictEqual(
    completed,
    [
      // No comment URL: nothing was posted, and the notice says so instead of staying open.
      ['run-unreachable-repository', 'notice-token', false]
    ],
    'an unrecoverable notice is concluded, not left claimable'
  )
})

test('a transient notice failure stays claimable for another attempt', async () => {
  // The opposite case: a 5xx or a dropped connection is worth retrying, so the notice must keep
  // its claim and be picked up again when the lease expires. Concluding it here would lose the
  // outcome the requester still has no way to read.
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-transient',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }
  // A 5xx is transient: the notice must stay claimed so the next lease retries it.
  const { app } = fakeApp({
    respond: () => githubJson({ message: 'Server Error' }, 503)
  })

  assert.strictEqual(
    await prepareReviewRunsOnce({ app, store: store as never }),
    true
  )
  assert.deepStrictEqual(
    completed,
    [],
    'a transient failure leaves the notice claimed for the next lease'
  )
})
