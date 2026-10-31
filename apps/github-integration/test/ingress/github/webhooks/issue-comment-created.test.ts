import assert from 'node:assert/strict'
import test from 'node:test'

import { setGitHubAppMetadata } from '../../../../src/github/github-app-metadata-service.js'
import type { ManualCommandAuthorizationDecision } from '../../../../src/github/manual-command-authorization.js'
import type { IssueContext } from '../../../../src/github/issue-service.js'
import type { PullRequestContext } from '../../../../src/github/pull-request-service.js'
import type { PreparedIssueReviewRun } from '../../../../src/reviews/issues/prepare-review.js'
import type { PreparedPullRequestReviewRun } from '../../../../src/reviews/pull-requests/prepare-review.js'
import { handleIssueCommentCreatedWithDeps } from '../../../../src/ingress/github/webhooks/issue-comment-created.js'
import { createLogThrottle } from '../../../../src/utils/log-throttle.js'
import { unusedGitHub } from '../../../github-client.js'

setGitHubAppMetadata({
  id: 1,
  slug: 'sec-review-bot',
  name: 'Sec Review Bot'
})

function createIssueCommentPayload({
  body = '@sec-review-bot review',
  is_pull_request = false
}: {
  body?: string
  is_pull_request?: boolean
} = {}) {
  return {
    action: 'created',
    repository: {
      name: 'example-repo',
      full_name: 'octo/example-repo',
      owner: {
        login: 'octo'
      },
      default_branch: 'main'
    },
    sender: {
      login: 'alice'
    },
    comment: {
      body
    },
    issue: {
      number: 7,
      title: 'Example issue',
      body: 'Body',
      state: 'open',
      user: {
        login: 'bob'
      },
      labels: [],
      html_url: 'https://example.test/issues/7',
      url: 'https://api.example.test/issues/7',
      comments_url: 'https://api.example.test/issues/7/comments',
      ...(is_pull_request ? { pull_request: {} } : {})
    }
  }
}

function authorizationDecision(
  overrides: Partial<ManualCommandAuthorizationDecision> = {}
): ManualCommandAuthorizationDecision {
  return {
    allowed: true,
    sender_login: 'alice',
    permission: 'write',
    required_permission: 'write',
    reason: 'allowed',
    ...overrides
  }
}

function pullRequestContext(): PullRequestContext {
  return {
    action: 'manual_review',
    previous_head_sha: null,
    repo_name: 'example-repo',
    repo_full_name: 'octo/example-repo',
    owner_login: 'octo',
    sender_login: null,
    pr_number: 7,
    pr_title: 'Example PR',
    pr_body: 'Body',
    pr_author: 'bob',
    is_draft: false,
    base_ref: 'main',
    base_sha: 'base-sha',
    head_ref: 'feature',
    head_sha: 'head-sha',
    commits: 1,
    changed_files: 1,
    additions: 1,
    deletions: 1,
    html_url: 'https://example.test/pull/7',
    api_url: 'https://api.example.test/pulls/7',
    commits_url: 'https://api.example.test/pulls/7/commits',
    review_comments_url: 'https://api.example.test/pulls/7/comments',
    comments_url: 'https://api.example.test/issues/7/comments',
    issue_url: 'https://api.example.test/issues/7',
    head_repo_full_name: 'octo/example-repo',
    base_repo_full_name: 'octo/example-repo',
    from_fork: false
  }
}

function submittedIssueRun(issue: IssueContext): PreparedIssueReviewRun {
  return {
    issue,
    run_id: 'run-issue-test',
    workspace_ref: 'workspace-ref',
    workflow: 'issue-review',
    event_type: 'manual_review',
    open_pr: false
  }
}

function submittedPullRequestRun(
  pr: PullRequestContext
): PreparedPullRequestReviewRun {
  return {
    pr,
    run_id: 'run-pr-test',
    files: [],
    workflow: 'pull-request-review',
    event_type: 'manual_review'
  }
}

test('issue-comment-created skips manual command when commenter lacks write permission', async () => {
  let issueReviewCalled = false
  let pullRequestReviewCalled = false

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-test',
      octokit: unusedGitHub().octokit,
      payload: createIssueCommentPayload()
    },
    {
      resolveTrustedDefaultBranchFn: async () => ({
        default_branch: 'main',
        head_sha: 'default-sha'
      }),
      authorizeManualCommentCommandFn: async () =>
        authorizationDecision({
          allowed: false,
          permission: 'read',
          reason: 'insufficient-permission'
        }),
      startIssueReviewCommandFn: async () => {
        issueReviewCalled = true
        throw new Error('issue review should not be called')
      },
      startPullRequestReviewCommandFn: async () => {
        pullRequestReviewCalled = true
        throw new Error('pull request review should not be called')
      }
    }
  )

  assert.strictEqual(issueReviewCalled, false)
  assert.strictEqual(pullRequestReviewCalled, false)
})

test('issue-comment-created starts an audited issue manual review for write commenter', async () => {
  let review_objective: 'audit' | 'repair' | null | undefined = null
  let open_pr: boolean | null | undefined
  let forwarded_trusted: { default_branch: string; head_sha: string } | null =
    null

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-test',
      octokit: unusedGitHub().octokit,
      payload: createIssueCommentPayload({
        body: '@sec-review-bot review'
      })
    },
    {
      resolveTrustedDefaultBranchFn: async () => ({
        default_branch: 'main',
        head_sha: 'default-sha'
      }),
      authorizeManualCommentCommandFn: async () => authorizationDecision(),
      startIssueReviewCommandFn: async ({
        issue,
        review_objective: next_review_objective,
        open_pr: next_open_pr,
        trusted_default_branch: next_trusted
      }) => {
        review_objective = next_review_objective
        open_pr = next_open_pr
        forwarded_trusted = next_trusted
        return submittedIssueRun(issue)
      }
    }
  )

  // An issue is an unverified claim, so a comment can only start an audit; the objective the
  // command path passes is always `audit`, never a user-chosen `repair`.
  assert.strictEqual(review_objective, 'audit')
  // A plain comment does not opt in to opening a draft PR.
  assert.strictEqual(open_pr, false)
  // The resolved trusted branch reaches the issue command.
  assert.deepStrictEqual(forwarded_trusted, {
    default_branch: 'main',
    head_sha: 'default-sha'
  })
})

test('issue-comment-created forwards the open-pr opt-in for issue reviews', async () => {
  let open_pr: boolean | null | undefined

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-draft-pr',
      octokit: unusedGitHub().octokit,
      payload: createIssueCommentPayload({
        body: '@sec-review-bot review --open-pr'
      })
    },
    {
      resolveTrustedDefaultBranchFn: async () => ({
        default_branch: 'main',
        head_sha: 'default-sha'
      }),
      authorizeManualCommentCommandFn: async () => authorizationDecision(),
      startIssueReviewCommandFn: async ({ issue, open_pr: next_open_pr }) => {
        open_pr = next_open_pr
        return submittedIssueRun(issue)
      }
    }
  )

  assert.strictEqual(open_pr, true)
})

test('issue-comment-created starts pull request manual review for write commenter', async () => {
  let pullRequestReviewCalled = false
  let forwarded_trusted: { default_branch: string; head_sha: string } | null =
    null

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-test',
      octokit: unusedGitHub().octokit,
      payload: createIssueCommentPayload({
        body: '@sec-review-bot review',
        is_pull_request: true
      })
    },
    {
      resolveTrustedDefaultBranchFn: async () => ({
        default_branch: 'main',
        head_sha: 'default-sha'
      }),
      authorizeManualCommentCommandFn: async () => authorizationDecision(),
      getPullRequestContextFn: async () => pullRequestContext(),
      startPullRequestReviewCommandFn: async ({
        resolve_pr,
        trusted_default_branch
      }) => {
        pullRequestReviewCalled = true
        forwarded_trusted = trusted_default_branch
        const pr = await resolve_pr?.()
        assert.ok(pr)
        return submittedPullRequestRun(pr)
      }
    }
  )

  assert.strictEqual(pullRequestReviewCalled, true)
  assert.deepStrictEqual(forwarded_trusted, {
    default_branch: 'main',
    head_sha: 'default-sha'
  })
})

test('issue-comment-created delegates PR context loading until after command admission', async () => {
  let contextLoaded = false
  let commandStarted = false

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-pr-context',
      octokit: unusedGitHub().octokit,
      payload: createIssueCommentPayload({
        body: '@sec-review-bot review',
        is_pull_request: true
      })
    },
    {
      resolveTrustedDefaultBranchFn: async () => ({
        default_branch: 'main',
        head_sha: 'default-sha'
      }),
      authorizeManualCommentCommandFn: async () => authorizationDecision(),
      getPullRequestContextFn: async () => {
        contextLoaded = true
        throw new Error('GitHub PR lookup failed')
      },
      startPullRequestReviewCommandFn: async ({ resolve_pr, on_admitted }) => {
        commandStarted = true
        assert.strictEqual(contextLoaded, false)
        assert.ok(resolve_pr)
        on_admitted?.({
          run_id: 'run-pr-context',
          status: 'pending',
          replayed: false
        })
        await assert.rejects(resolve_pr(), /GitHub PR lookup failed/)
        return { run_id: 'run-pr-context' }
      }
    }
  )

  assert.strictEqual(commandStarted, true)
  assert.strictEqual(contextLoaded, true)
})

test('an unrecognized mention logs at most once per repository per window', async () => {
  // The diagnostic is text anyone can type, so it must not be an unbounded log stream. The
  // handler consults the throttle before logging; here the throttle is driven directly so the
  // assertion does not depend on wall-clock time or on other tests' traffic.
  const logged: Array<Record<string, unknown>> = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    const text = String(chunk)
    if (text.includes('comment_mention_not_recognized')) {
      logged.push({ line: text })
    }
    return true
  }) as typeof process.stdout.write

  // The real throttle, with a frozen clock so "same window" is deterministic and independent of
  // other tests that may already have logged for these repositories.
  const throttle = createLogThrottle({
    minIntervalMs: 5 * 60_000,
    maxKeys: 200,
    now: () => 0
  })
  try {
    const payload = createIssueCommentPayload({
      body: 'hey @someone-else please'
    })
    for (const repository of ['octo/one', 'octo/two']) {
      // Each repository is a distinct throttle key: the first sighting logs, the second does not.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await handleIssueCommentCreatedWithDeps(
          {
            id: `delivery-${repository}-${attempt}`,
            octokit: unusedGitHub().octokit,
            payload: {
              ...payload,
              repository: { ...payload.repository, full_name: repository }
            }
          },
          { unmatchedMentionThrottleFn: throttle }
        )
      }
    }
  } finally {
    process.stdout.write = originalWrite
  }

  assert.strictEqual(
    logged.length,
    2,
    'one diagnostic line per repository, not one per comment'
  )
})
