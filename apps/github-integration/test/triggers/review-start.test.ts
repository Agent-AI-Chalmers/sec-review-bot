import assert from 'node:assert/strict'
import test from 'node:test'

import { startIssueReviewCommand } from '../../triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../../triggers/pull-request-review.js'
import type { IssueContext } from '../../infrastructure/github/issue-service.js'
import type { PullRequestContext } from '../../infrastructure/github/pull-request-service.js'

function issueContext (): IssueContext {
  return {
    action: 'opened',
    repo_name: 'example-repo',
    repo_full_name: 'octo/example-repo',
    owner_login: 'octo',
    sender_login: 'alice',
    default_branch: 'main',
    issue_number: 12,
    issue_title: 'Example issue',
    issue_body: 'Body',
    issue_author: 'alice',
    issue_state: 'open',
    labels: [],
    html_url: 'https://example.test/issues/12',
    api_url: 'https://api.example.test/issues/12',
    comments_url: 'https://api.example.test/issues/12/comments',
    is_pull_request: false
  }
}

function pullRequestContext (): PullRequestContext {
  return {
    action: 'opened',
    previous_head_sha: null,
    repo_name: 'example-repo',
    repo_full_name: 'octo/example-repo',
    owner_login: 'octo',
    sender_login: 'alice',
    pr_number: 7,
    pr_title: 'Example PR',
    pr_body: 'Body',
    pr_author: 'alice',
    is_draft: false,
    base_ref: 'main',
    base_sha: 'base-sha',
    head_ref: 'feature',
    head_sha: 'head-sha',
    commits: 1,
    changed_files: 1,
    additions: 10,
    deletions: 2,
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

test('startIssueReviewCommand starts and persists a queued issue review run', async () => {
  const issue = issueContext()
  const saved_runs: unknown[] = []

  const submitted = await startIssueReviewCommand({
    octokit: {},
    issue,
    event_type: 'opened',
    deps: {
      start_review: async ({ issue: submittedIssue, event_type, review_objective, repair_mode }) => {
        assert.equal(event_type, 'opened')
        assert.equal(review_objective, 'audit')
        assert.equal(repair_mode, null)
        return {
          issue: submittedIssue,
          run_id: 'run-issue-1',
          workspace_ref: 'workspace-ref',
          workflow: 'issue-review',
          event_type: 'opened'
        }
      },
      store: {
        save_queued_run: (run) => {
          saved_runs.push(run)
          return run as never
        }
      }
    }
  })

  assert.equal(submitted.run_id, 'run-issue-1')
  assert.deepEqual(saved_runs, [{
    workflow: 'issue-review',
    run_id: 'run-issue-1',
    publish_context: {
      issue,
      workspace_ref: 'workspace-ref',
      event_type: 'opened'
    }
  }])
})

test('startPullRequestReviewCommand starts and persists a queued PR review run', async () => {
  const pr = pullRequestContext()
  const saved_runs: unknown[] = []

  const submitted = await startPullRequestReviewCommand({
    octokit: {},
    pr,
    event_type: 'manual_review',
    repair_mode: 'no-test-changes',
    deps: {
      start_review: async ({ pr: submittedPr, event_type, repair_mode }) => {
        assert.equal(event_type, 'manual_review')
        assert.equal(repair_mode, 'no-test-changes')
        return {
          pr: submittedPr,
          run_id: 'run-pr-1',
          files: [{ filename: 'src/app.ts' }],
          workflow: 'pull-request-review',
          event_type: 'manual_review'
        }
      },
      store: {
        save_queued_run: (run) => {
          saved_runs.push(run)
          return run as never
        }
      }
    }
  })

  assert.equal(submitted.run_id, 'run-pr-1')
  assert.deepEqual(saved_runs, [{
    workflow: 'pull-request-review',
    run_id: 'run-pr-1',
    publish_context: {
      files: [{ filename: 'src/app.ts' }],
      pr,
      event_type: 'manual_review'
    }
  }])
})
