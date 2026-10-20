// Verifies recovery-only preparation inputs can deliver their terminal notice
// without a live webhook payload or a fully materialized pull-request context.
import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareReviewRunsOnce } from '../../src/control-plane/preparation-coordinator.js'
import type { PreparationCoordinatorStore } from '../../src/control-plane/client.js'
import { fakeApp } from '../github-app-stubs.js'
import { fakeGitHub, githubJson } from '../github-client.js'

/**
 * The members `prepareReviewRunsOnce` may reach but a notice-only test never triggers.
 *
 * The coordinator can take either branch (deliver a failure notice, or claim and execute
 * preparation), so its store type includes both. A test that exercises only the notice branch
 * still has to satisfy the type; these members fail loudly if the unreached branch is somehow
 * entered, which is more informative than a silent `undefined`.
 */
function unreachedPreparationMembers(): Pick<
  PreparationCoordinatorStore,
  | 'admitReviewRun'
  | 'submitPreparedRun'
  | 'renewPreparationClaim'
  | 'preparationHeartbeatIntervalMs'
> {
  const unreached = (name: string): never => {
    throw new Error(`the ${name} branch should not be reached in this test`)
  }
  return {
    admitReviewRun: async () => unreached('admitReviewRun'),
    submitPreparedRun: async () => unreached('submitPreparedRun'),
    renewPreparationClaim: async () => unreached('renewPreparationClaim'),
    preparationHeartbeatIntervalMs: () =>
      unreached('preparationHeartbeatIntervalMs')
  }
}

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
    claimNextRunNotice: async () => ({
      run_id: 'run-pr-reference',
      notice_id: 'notice-test',
      input: {
        kind: 'github_pull_request_review',
        pr_reference: {
          owner_login: 'octo',
          repo_name: 'example',
          pr_number: 7
        }
      },
      axis: 'preparation' as const,
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure' as const,
      claim_token: 'notice-token'
    }),
    completeRunNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority'),
    failPreparation: async () =>
      assert.fail('notice path must not fail preparation'),
    ...unreachedPreparationMembers()
  }

  assert.strictEqual(await prepareReviewRunsOnce({ app, store }), true)
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
    ['notice-test', 'notice-token', true, 'https://example.test/comment/9']
  ])
})

test('preparation-first scheduling falls back to a terminal notice when no preparation is ready', async () => {
  const calls: string[] = []
  const store = {
    claimNextPreparation: async () => {
      calls.push('preparation')
      return null
    },
    claimNextRunNotice: async () => {
      calls.push('notice')
      return {
        run_id: 'run-without-reply-target',
        notice_id: 'notice-test',
        input: {},
        axis: 'preparation' as const,
        reason_code: 'PREPARATION_RETRY_EXHAUSTED',
        kind: 'failure' as const,
        claim_token: 'notice-claim'
      }
    },
    completeRunNotice: async () => {
      calls.push('complete-notice')
      return true
    },
    failPreparation: async () => assert.fail('no preparation should fail here'),
    ...unreachedPreparationMembers()
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({
      // Nothing here may reach GitHub: any request would surface as a recorded request.
      app: fakeApp().app,
      store,
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
    claimNextRunNotice: async () => ({
      run_id: 'run-repository',
      notice_id: 'notice-test',
      input: {
        kind: 'github_repository_review',
        payload: { repo_full_name: 'octo/example' },
        verified_repository: 'octo/example'
      },
      axis: 'preparation' as const,
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure' as const,
      claim_token: 'notice-token'
    }),
    completeRunNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority'),
    failPreparation: async () =>
      assert.fail('notice path must not fail preparation'),
    ...unreachedPreparationMembers()
  }

  assert.strictEqual(await prepareReviewRunsOnce({ app, store }), true)
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
    ['notice-test', 'notice-token', true, 'https://example.test/comment/5']
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
    claimNextRunNotice: async () => ({
      run_id: 'run-unreachable-repository',
      notice_id: 'notice-test',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      axis: 'preparation' as const,
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure' as const,
      claim_token: 'notice-token'
    }),
    completeRunNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority'),
    failPreparation: async () =>
      assert.fail('notice path must not fail preparation'),
    ...unreachedPreparationMembers()
  }
  // A 404 from the installation lookup is what GitHub answers for "this app is not installed";
  // retrying can never change it, so the notice must be concluded as undelivered.
  const { app } = fakeApp({
    respond: () => githubJson({ message: 'Not Found' }, 404)
  })

  assert.strictEqual(await prepareReviewRunsOnce({ app, store }), true)
  assert.deepStrictEqual(
    completed,
    [
      // No comment URL: nothing was posted, and the notice says so instead of staying open.
      ['notice-test', 'notice-token', false]
    ],
    'an unrecoverable notice is concluded, not left claimable'
  )
})

test('a process without the GitHub installation concludes the notice, which the single-role assumption forbids', async () => {
  // The notice claim is per connector, not per capability: every process running this coordinator
  // shares one outbox, and the oldest pending notice is what any of them takes next. That is only
  // safe because the deployment runs one coordinator role per connector, each holding the App
  // credentials a reply needs.
  //
  // This test pins the consequence of breaking that assumption, so the cost of a future
  // publisher-only deployment is visible instead of discovered in production: a process that
  // cannot reach the installation takes the notice, fails deterministically, and the outbox
  // records "the requester was not told" even though another process could have told them. No
  // claim-side gate exists to prevent it; if such a deployment ever exists, the claim needs a
  // role or capability rather than a second queue.
  const completed: unknown[] = []
  let claimed = 0
  const store = {
    claimNextRunNotice: async () => {
      claimed += 1
      return {
        run_id: 'run-wrong-role',
        notice_id: 'notice-test',
        input: {
          kind: 'github_repository_review',
          verified_repository: 'octo/example'
        },
        axis: 'preparation' as const,
        reason_code: 'PREPARATION_RETRY_EXHAUSTED',
        kind: 'failure' as const,
        claim_token: 'notice-token'
      }
    },
    completeRunNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () =>
      assert.fail('the notice was already handled this pass'),
    failPreparation: async () =>
      assert.fail('the notice path must not fail preparation'),
    ...unreachedPreparationMembers()
  }
  // No installation is visible to this process: the App answers 404 for the scanned repository.
  const { app } = fakeApp({
    respond: () => githubJson({ message: 'Not Found' }, 404)
  })

  assert.strictEqual(await prepareReviewRunsOnce({ app, store }), true)
  assert.strictEqual(
    claimed,
    1,
    'the claim is per connector, so this process takes it'
  )
  assert.deepStrictEqual(
    completed,
    [['notice-test', 'notice-token', false]],
    'the notice is concluded as undelivered, not left for a process that could deliver it'
  )
})

test('a transient notice failure stays claimable for another attempt', async () => {
  // The opposite case: a 5xx or a dropped connection is worth retrying, so the notice must keep
  // its claim and be picked up again when the lease expires. Concluding it here would lose the
  // outcome the requester still has no way to read.
  const completed: unknown[] = []
  const store = {
    claimNextRunNotice: async () => ({
      run_id: 'run-transient',
      notice_id: 'notice-test',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      axis: 'preparation' as const,
      reason_code: 'PREPARATION_RETRY_EXHAUSTED',
      kind: 'failure' as const,
      claim_token: 'notice-token'
    }),
    completeRunNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority'),
    failPreparation: async () =>
      assert.fail('notice path must not fail preparation'),
    ...unreachedPreparationMembers()
  }
  // A 5xx is transient: the notice must stay claimed so the next lease retries it.
  const { app } = fakeApp({
    respond: () => githubJson({ message: 'Server Error' }, 503)
  })

  assert.strictEqual(await prepareReviewRunsOnce({ app, store }), true)
  assert.deepStrictEqual(
    completed,
    [],
    'a transient failure leaves the notice claimed for the next lease'
  )
})

test('a recovered preparation with a malformed persisted issue is rejected, not cast', async () => {
  // The issue record is replayed from storage, so it is untyped JSON. A missing field must fail as
  // invalid preparation input rather than produce a context whose fields are `undefined`.
  const store = {
    claimNextRunNotice: async () => null,
    claimNextPreparation: async () => ({
      run_id: 'run-malformed-issue',
      workflow: 'issue-review' as const,
      input_version: 'v1',
      attempt_count: 1,
      claim_token: 'token',
      input: {
        kind: 'github_issue_review',
        // `repo_full_name` and the rest are missing.
        issue: { issue_number: 1 },
        trusted_default_branch: { default_branch: 'main', head_sha: 'sha' },
        event_type: 'opened',
        review_objective: null,
        test_changes: null,
        open_pr: null
      }
    }),
    ...unreachedPreparationMembers()
  }

  // The coordinator concludes the failed attempt through `failPreparation` rather than throwing:
  // one bad record must not abort the whole pass.
  const failures: Array<{ message: string }> = []
  const failing = {
    ...store,
    completeRunNotice: async () => true,
    failPreparation: async (
      _runId: string,
      _token: string,
      failure: { message: string }
    ) => {
      failures.push(failure)
      return { retry_scheduled: false }
    }
  }

  await prepareReviewRunsOnce({
    app: fakeApp().app,
    store: failing,
    preferFailureNotice: false
  })

  assert.strictEqual(failures.length, 1)
  assert.match(failures[0]!.message, /Preparation input .*issue\./)
})

test('a recovered preparation with a malformed trusted default branch is rejected', async () => {
  const store = {
    claimNextRunNotice: async () => null,
    claimNextPreparation: async () => ({
      run_id: 'run-malformed-branch',
      workflow: 'issue-review' as const,
      input_version: 'v1',
      attempt_count: 1,
      claim_token: 'token',
      input: {
        kind: 'github_issue_review',
        issue: {
          action: 'opened',
          repo_name: 'example',
          repo_full_name: 'octo/example',
          owner_login: 'octo',
          sender_login: 'commenter',
          default_branch: 'main',
          issue_number: 1,
          issue_title: 'title',
          issue_body: null,
          issue_author: 'author',
          issue_state: 'open',
          labels: [],
          html_url: 'https://example.test/issues/1',
          api_url: 'https://api.example.test/issues/1',
          comments_url: 'https://api.example.test/issues/1/comments',
          is_pull_request: false
        },
        // `head_sha` missing.
        trusted_default_branch: { default_branch: 'main' },
        event_type: 'opened',
        review_objective: null,
        test_changes: null,
        open_pr: null
      }
    }),
    ...unreachedPreparationMembers()
  }

  const failures: Array<{ message: string }> = []
  const failing = {
    ...store,
    completeRunNotice: async () => true,
    failPreparation: async (
      _runId: string,
      _token: string,
      failure: { message: string }
    ) => {
      failures.push(failure)
      return { retry_scheduled: false }
    }
  }

  await prepareReviewRunsOnce({
    // The installation lookup must succeed: the issue is validated first, then the installation
    // is resolved, and only then is the trusted branch read.
    app: fakeApp({ respond: () => githubJson({ id: 1 }) }).app,
    store: failing,
    preferFailureNotice: false
  })

  assert.strictEqual(failures.length, 1)
  assert.match(failures[0]!.message, /trusted_default_branch\.head_sha/)
})

test('a recovered issue that omits sender_login or issue_author is rejected', async () => {
  // There is no forward compatibility: every field the recovered context declares must be
  // present. An older record that lacks one is a failed preparation, not a context whose fields
  // are silently `undefined`.
  const issue = {
    action: 'opened',
    repo_name: 'example',
    repo_full_name: 'octo/example',
    owner_login: 'octo',
    default_branch: 'main',
    issue_number: 1,
    issue_title: 'title',
    issue_body: null,
    issue_state: 'open',
    labels: [],
    html_url: 'https://example.test/issues/1',
    api_url: 'https://api.example.test/issues/1',
    comments_url: 'https://api.example.test/issues/1/comments',
    is_pull_request: false
  }

  for (const [present, missing, expected] of [
    ['sender_login', 'issue_author', /issue\.issue_author/],
    ['issue_author', 'sender_login', /issue\.sender_login/]
  ] as const) {
    // Start from a complete record, then drop only the field under test. The other nullable
    // field is present, so the assertion names the field that is actually missing.
    const partialIssue: Record<string, unknown> = {
      ...issue,
      [present]: present
    }
    delete partialIssue[missing]
    const failures: Array<{ message: string }> = []
    const store = {
      claimNextRunNotice: async () => null,
      claimNextPreparation: async () => ({
        run_id: `run-missing-${missing}`,
        workflow: 'issue-review' as const,
        input_version: 'v1',
        attempt_count: 1,
        claim_token: 'token',
        input: {
          kind: 'github_issue_review',
          issue: partialIssue,
          trusted_default_branch: { default_branch: 'main', head_sha: 'sha' },
          event_type: 'opened',
          review_objective: null,
          test_changes: null,
          open_pr: null
        }
      }),
      completeRunNotice: async () => true,
      failPreparation: async (
        _runId: string,
        _token: string,
        failure: { message: string }
      ) => {
        failures.push(failure)
        return { retry_scheduled: false }
      },
      ...unreachedPreparationMembers()
    }

    await prepareReviewRunsOnce({
      // The record must be rejected before any installation or GitHub work.
      app: fakeApp().app,
      store,
      preferFailureNotice: false
    })

    assert.strictEqual(
      failures.length,
      1,
      `a record missing ${missing} must be rejected`
    )
    assert.match(failures[0]!.message, expected)
  }
})

test('a recovered issue carrying a non-string author is rejected', async () => {
  // A wrong type is rejected too: the field must be a string, and `null`/numbers are not.
  for (const bad of [null, 123, {}]) {
    const failures: Array<{ message: string }> = []
    const store = {
      claimNextRunNotice: async () => null,
      claimNextPreparation: async () => ({
        run_id: 'run-bad-author',
        workflow: 'issue-review' as const,
        input_version: 'v1',
        attempt_count: 1,
        claim_token: 'token',
        input: {
          kind: 'github_issue_review',
          issue: {
            action: 'opened',
            repo_name: 'example',
            repo_full_name: 'octo/example',
            owner_login: 'octo',
            sender_login: 'commenter',
            default_branch: 'main',
            issue_number: 1,
            issue_title: 'title',
            issue_body: null,
            issue_author: bad,
            issue_state: 'open',
            labels: [],
            html_url: 'https://example.test/issues/1',
            api_url: 'https://api.example.test/issues/1',
            comments_url: 'https://api.example.test/issues/1/comments',
            is_pull_request: false
          },
          trusted_default_branch: { default_branch: 'main', head_sha: 'sha' },
          event_type: 'opened',
          review_objective: null,
          test_changes: null,
          open_pr: null
        }
      }),
      completeRunNotice: async () => true,
      failPreparation: async (
        _runId: string,
        _token: string,
        failure: { message: string }
      ) => {
        failures.push(failure)
        return { retry_scheduled: false }
      },
      ...unreachedPreparationMembers()
    }

    await prepareReviewRunsOnce({
      app: fakeApp().app,
      store,
      preferFailureNotice: false
    })

    assert.strictEqual(
      failures.length,
      1,
      `${JSON.stringify(bad)} must be rejected`
    )
    assert.match(failures[0]!.message, /issue\.issue_author/)
  }
})

/** A pull request payload shaped like the one admission persists. */
function admittedPullRequestPayload(): Record<string, unknown> {
  return {
    action: 'synchronize',
    previous_head_sha: 'prev1111',
    repo_name: 'demo',
    repo_full_name: 'octo/demo',
    owner_login: 'octo',
    sender_login: 'alice',
    pr_number: 7,
    pr_title: 'Update app',
    pr_body: 'body',
    pr_author: 'alice',
    is_draft: false,
    base_ref: 'main',
    base_sha: 'base0000',
    head_ref: 'feature',
    head_sha: 'head0000',
    commits: 2,
    changed_files: 1,
    additions: 1,
    deletions: 1,
    html_url: 'https://example.test/octo/demo/pull/7',
    api_url: 'https://api.test/repos/octo/demo/pulls/7',
    commits_url: 'https://api.test/repos/octo/demo/pulls/7/commits',
    review_comments_url: 'https://api.test/repos/octo/demo/pulls/7/comments',
    comments_url: 'https://api.test/repos/octo/demo/pulls/7/comments',
    issue_url: 'https://api.test/repos/octo/demo/issues/7',
    head_repo_full_name: 'octo/demo',
    base_repo_full_name: 'octo/demo',
    from_fork: false
  }
}

test('a claimed synchronize preparation recovers from the payload admission persisted', async () => {
  // Admission persists the parsed webhook payload, before any preparation has run,
  // so the stored subject has no window and no commit list yet. The recovery path
  // must accept that shape: rejecting it fails every pull request recovery between
  // admission and a completed preparation. It must also keep the synchronize
  // window: re-reading the pull request loses the webhook `before` commit and
  // silently widens the run to the whole pull request.
  const client = fakeGitHub(({ url }) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/comments')) return githubJson([])
    return githubJson({
      id: 7,
      number: 7,
      title: 'Update app',
      body: 'body',
      draft: false,
      html_url: 'https://example.test/octo/demo/pull/7',
      user: { login: 'alice' },
      base: {
        ref: 'main',
        sha: 'newbase0',
        repo: { full_name: 'octo/demo', owner: { login: 'octo' } }
      },
      head: {
        ref: 'feature',
        sha: 'newhead0',
        repo: { full_name: 'octo/demo' }
      }
    })
  })
  const { app } = fakeApp({
    respond: () => githubJson({ id: 1 }),
    installationOctokit: client.octokit as never
  })
  const failures: string[] = []
  let claimed = false
  const store = {
    claimNextPreparation: async () => {
      if (claimed) return null
      claimed = true
      return {
        run_id: 'run-recover',
        claim_token: 'claim-token',
        attempt_count: 1,
        workflow: 'pull-request-review' as const,
        input_version: 'v1' as const,
        input: {
          kind: 'github_pull_request_review',
          pr: admittedPullRequestPayload(),
          trusted_default_branch: {
            default_branch: 'main',
            head_sha: 'base0000'
          },
          event_type: 'synchronize',
          test_changes: null
        }
      } as never
    },
    claimNextRunNotice: async () => null,
    failPreparation: async (_run: string, _token: string, error: unknown) => {
      failures.push(String((error as { message?: string })?.message ?? error))
      return true
    },
    renewPreparationClaim: async () => true,
    preparationHeartbeatIntervalMs: () => 60_000,
    ...(() => {
      const unreached = (name: string): never => {
        throw new Error(`the ${name} branch should not be reached in this test`)
      }
      return {
        admitReviewRun: async () => unreached('admitReviewRun'),
        submitPreparedRun: async () => unreached('submitPreparedRun')
      }
    })()
  }

  await prepareReviewRunsOnce({
    app,
    store: store as never,
    preferFailureNotice: false
  })

  // Preparation itself is exercised elsewhere; this test is about whether the
  // recovery path accepts the admitted payload at all. A validation rejection
  // names the missing field, so only that is treated as a failure here.
  const validation_failures = failures.filter((message) =>
    /^Preparation input is missing /.test(message)
  )
  assert.deepStrictEqual(
    validation_failures,
    [],
    `recovery rejected the admitted payload: ${validation_failures.join('; ')}`
  )
  // The recovered run must not narrow to a freshly fetched pull request: the
  // webhook `before` commit only exists in the persisted payload.
  assert.strictEqual(
    client.requests.some(
      (request) =>
        request.method === 'GET' &&
        /\/pulls\/7$/.test(new URL(request.url).pathname)
    ),
    false,
    'recovery must not re-read the pull request'
  )
})
