import assert from 'node:assert/strict'
import test from 'node:test'

import { setGitHubAppMetadata } from '../../../../infrastructure/github/github-app-metadata-service.js'
import type { ManualCommandAuthorizationDecision } from '../../../../infrastructure/github/manual-command-authorization.js'
import type { IssueContext } from '../../../../infrastructure/github/issue-service.js'
import type { PullRequestContext } from '../../../../infrastructure/github/pull-request-service.js'
import type { SubmittedIssueReviewRun } from '../../../../reviews/issues/submit.js'
import type { SubmittedPullRequestReviewRun } from '../../../../reviews/pull-requests/submit.js'
import { handleIssueCommentCreatedWithDeps } from '../../../../interfaces/github/webhooks/issue-comment-created.js'

setGitHubAppMetadata({
  id: 1,
  slug: 'sec-review-bot',
  name: 'Sec Review Bot'
})

function createIssueCommentPayload ({
  body = '@sec-review-bot review audit',
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

function authorizationDecision (
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

function pullRequestContext (): PullRequestContext {
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

function submittedIssueRun (issue: IssueContext): SubmittedIssueReviewRun {
  return {
    issue,
    run_id: 'run-issue-test',
    workspace_ref: 'workspace-ref',
    workflow: 'issue-review',
    event_type: 'manual_review'
  }
}

function submittedPullRequestRun (pr: PullRequestContext): SubmittedPullRequestReviewRun {
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
      octokit: {},
      payload: createIssueCommentPayload()
    },
    {
      authorizeManualCommentCommandFn: async () => authorizationDecision({
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

test('issue-comment-created starts issue manual review for write commenter', async () => {
  let review_objective: 'audit' | 'repair' | null | undefined = null

  await handleIssueCommentCreatedWithDeps(
    {
      octokit: {},
      payload: createIssueCommentPayload({
        body: '@sec-review-bot review repair'
      })
    },
    {
      authorizeManualCommentCommandFn: async () => authorizationDecision(),
      startIssueReviewCommandFn: async ({ issue, review_objective: next_review_objective }) => {
        review_objective = next_review_objective
        return submittedIssueRun(issue)
      }
    }
  )

  assert.equal(review_objective, 'repair')
})

test('issue-comment-created starts pull request manual review for write commenter', async () => {
  let pullRequestReviewCalled = false

  await handleIssueCommentCreatedWithDeps(
    {
      octokit: {},
      payload: createIssueCommentPayload({
        body: '@sec-review-bot review',
        is_pull_request: true
      })
    },
    {
      authorizeManualCommentCommandFn: async () => authorizationDecision(),
      getPullRequestContextFn: async () => pullRequestContext(),
      startPullRequestReviewCommandFn: async ({ pr }) => {
        pullRequestReviewCalled = true
        return submittedPullRequestRun(pr)
      }
    }
  )

  assert.equal(pullRequestReviewCalled, true)
}
)
