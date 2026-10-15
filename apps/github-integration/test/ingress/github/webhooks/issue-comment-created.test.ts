import assert from 'node:assert/strict'
import test from 'node:test'

import { setGitHubAppMetadata } from '../../../../src/github/github-app-metadata-service.js'
import type { ManualCommandAuthorizationDecision } from '../../../../src/github/manual-command-authorization.js'
import type { IssueContext } from '../../../../src/github/issue-service.js'
import type { PullRequestContext } from '../../../../src/github/pull-request-service.js'
import type { SubmittedIssueReviewRun } from '../../../../src/reviews/issues/submit.js'
import type { SubmittedPullRequestReviewRun } from '../../../../src/reviews/pull-requests/submit.js'
import { handleIssueCommentCreatedWithDeps } from '../../../../src/ingress/github/webhooks/issue-comment-created.js'

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

function submittedIssueRun(issue: IssueContext): SubmittedIssueReviewRun {
  return {
    issue,
    run_id: 'run-issue-test',
    workspace_ref: 'workspace-ref',
    workflow: 'issue-review',
    event_type: 'manual_review',
    open_pr: false
  }
}

function submittedPullRequestRun(pr: PullRequestContext): SubmittedPullRequestReviewRun {
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
      octokit: {},
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

  assert.equal(issueReviewCalled, false)
  assert.equal(pullRequestReviewCalled, false)
})

test('issue-comment-created starts an audited issue manual review for write commenter', async () => {
  let review_objective: 'audit' | 'repair' | null | undefined = null
  let open_pr: boolean | null | undefined
  let forwarded_trusted: { default_branch: string; head_sha: string } | null = null

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-test',
      octokit: {},
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
  assert.equal(review_objective, 'audit')
  // A plain comment does not opt in to opening a draft PR.
  assert.equal(open_pr, false)
  // The resolved trusted branch reaches the issue command.
  assert.deepEqual(forwarded_trusted, { default_branch: 'main', head_sha: 'default-sha' })
})

test('issue-comment-created forwards the open-pr opt-in for issue reviews', async () => {
  let open_pr: boolean | null | undefined

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-draft-pr',
      octokit: {},
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

  assert.equal(open_pr, true)
})

test('issue-comment-created starts pull request manual review for write commenter', async () => {
  let pullRequestReviewCalled = false
  let forwarded_trusted: { default_branch: string; head_sha: string } | null = null

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-test',
      octokit: {},
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
      startPullRequestReviewCommandFn: async ({ resolve_pr, trusted_default_branch }) => {
        pullRequestReviewCalled = true
        forwarded_trusted = trusted_default_branch
        const pr = await resolve_pr?.()
        assert.ok(pr)
        return submittedPullRequestRun(pr)
      }
    }
  )

  assert.equal(pullRequestReviewCalled, true)
  assert.deepEqual(forwarded_trusted, { default_branch: 'main', head_sha: 'default-sha' })
})

test('issue-comment-created delegates PR context loading until after command admission', async () => {
  let contextLoaded = false
  let commandStarted = false

  await handleIssueCommentCreatedWithDeps(
    {
      id: 'delivery-pr-context',
      octokit: {},
      payload: createIssueCommentPayload({ body: '@sec-review-bot review', is_pull_request: true })
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
        assert.equal(contextLoaded, false)
        assert.ok(resolve_pr)
        on_admitted?.({ run_id: 'run-pr-context', status: 'preparing', replayed: false })
        await assert.rejects(resolve_pr(), /GitHub PR lookup failed/)
        return { run_id: 'run-pr-context' }
      }
    }
  )

  assert.equal(commandStarted, true)
  assert.equal(contextLoaded, true)
})
