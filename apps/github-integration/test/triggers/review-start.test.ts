import assert from 'node:assert/strict'
import test from 'node:test'

import { startIssueReviewCommand } from '../../src/triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../../src/triggers/pull-request-review.js'
import type { IssueContext } from '../../src/infrastructure/github/issue-service.js'
import type { PullRequestContext } from '../../src/infrastructure/github/pull-request-service.js'
import { RunnerSubmissionUncertainError } from '../../src/infrastructure/runner/client.js'

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
  const transitions: unknown[] = []

  const submitted = await startIssueReviewCommand({
    octokit: {},
    issue,
    event_type: 'opened',
    delivery_id: 'delivery-issue-1',
    deps: {
      create_run_id: () => 'run-issue-1',
      start_review: async ({ issue: submittedIssue, run_id, event_type, review_objective, repair_mode }) => {
        assert.equal(run_id, 'run-issue-1')
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
        admit_review_run: (run) => {
          transitions.push(['preparing', run])
          return { record: run, created: true, preparation_token: 'claim' } as never
        },
        mark_queued: (run_id, _token, publish_context) => transitions.push(['queued', run_id, publish_context]),
        failPreparation: () => assert.fail('successful review must not be marked failed')
      }
    }
  })

  assert.equal(submitted.run_id, 'run-issue-1')
  assert.deepEqual(transitions, [
    ['preparing', {
      workflow: 'issue-review',
      run_id: 'run-issue-1',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: 'delivery-issue-1'
    }],
    ['queued', 'run-issue-1', {
      issue: {
        owner_login: 'octo',
        repo_name: 'example-repo',
        repo_full_name: 'octo/example-repo',
        default_branch: 'main',
        issue_number: 12,
        issue_title: 'Example issue'
      },
      workspace_ref: 'workspace-ref',
      event_type: 'opened'
    }]
  ])
})

test('startPullRequestReviewCommand starts and persists a queued PR review run', async () => {
  const pr = pullRequestContext()
  const transitions: unknown[] = []

  const submitted = await startPullRequestReviewCommand({
    octokit: {},
    pr,
    event_type: 'manual_review',
    delivery_id: 'delivery-pr-1',
    repair_mode: 'no-test-changes',
    deps: {
      create_run_id: () => 'run-pr-1',
      start_review: async ({ pr: submittedPr, run_id, event_type, repair_mode }) => {
        assert.equal(run_id, 'run-pr-1')
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
        admit_review_run: (run) => {
          transitions.push(['preparing', run])
          return { record: run, created: true, preparation_token: 'claim' } as never
        },
        mark_queued: (run_id, _token, publish_context) => transitions.push(['queued', run_id, publish_context]),
        failPreparation: () => assert.fail('successful review must not be marked failed')
      }
    }
  })

  assert.equal(submitted.run_id, 'run-pr-1')
  assert.deepEqual(transitions, [
    ['preparing', {
      workflow: 'pull-request-review',
      run_id: 'run-pr-1',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: 'delivery-pr-1'
    }],
    ['queued', 'run-pr-1', {
      files: [{ filename: 'src/app.ts' }],
      pr: {
        owner_login: 'octo',
        repo_name: 'example-repo',
        repo_full_name: 'octo/example-repo',
        pr_number: 7,
        pr_author: 'alice',
        head_sha: 'head-sha'
      },
      event_type: 'manual_review'
    }]
  ])
})

test('startPullRequestReviewCommand records a failed run when preparation or submission fails', async () => {
  // The run is deliberately admitted before preparation fails: operators must
  // be able to find the failed attempt and its delivery identity afterwards.
  const transitions: unknown[] = []

  await assert.rejects(
    startPullRequestReviewCommand({
      octokit: {},
      pr: pullRequestContext(),
      event_type: 'opened',
      delivery_id: 'delivery-pr-failed',
      deps: {
        create_run_id: () => 'run-pr-failed',
        start_review: async ({ run_id }) => {
          assert.equal(run_id, 'run-pr-failed')
          throw new Error('workspace clone failed')
        },
        store: {
          admit_review_run: (run) => {
            transitions.push(['preparing', run])
            return { record: run, created: true, preparation_token: 'claim' } as never
          },
          mark_queued: () => assert.fail('failed review must not be queued'),
          failPreparation: (run_id, _token, error) => transitions.push(['failed', run_id, error])
        }
      }
    }),
    /workspace clone failed/
  )

  assert.deepEqual(transitions, [
    ['preparing', {
      workflow: 'pull-request-review',
      run_id: 'run-pr-failed',
      publish_context: {},
      ingress_kind: 'github_webhook',
      ingress_key: 'delivery-pr-failed'
    }],
    ['failed', 'run-pr-failed', { code: 'REVIEW_START_FAILED', message: 'workspace clone failed' }]
  ])
})

test('startIssueReviewCommand preserves an uncertain Runner submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new RunnerSubmissionUncertainError('Runner response was lost.')

  await assert.rejects(
    startIssueReviewCommand({
      octokit: {},
      issue: issueContext(),
      event_type: 'opened',
      delivery_id: 'delivery-uncertain',
      deps: {
        create_run_id: () => 'run-uncertain',
        start_review: async (args) => {
          args.on_prepared?.({ issue: args.issue, run_id: 'run-uncertain', workspace_ref: 'workspace-ref', workflow: 'issue-review', event_type: 'opened' }, { contract_version: 'v5' } as never)
          throw error
        },
        store: {
          admit_review_run: (run) => ({ record: { ...run, status: 'preparing' }, created: true, preparation_token: 'claim' }) as never,
          save_prepared_submission: (run_id, _token, context, input) => transitions.push(['prepared', run_id, context, input]),
          mark_queued: () => assert.fail('uncertain submission must not queue yet'),
          failPreparation: (run_id, _token, failure) => transitions.push([run_id, failure])
        }
      }
    }),
    error
  )

  assert.equal((transitions[0] as unknown[])[0], 'prepared')
  assert.deepEqual(transitions[1], [
    'run-uncertain',
    { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'Runner response was lost.' }
  ])
})

test('startPullRequestReviewCommand preserves an uncertain Runner submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new RunnerSubmissionUncertainError('Runner response was lost.')

  await assert.rejects(
    startPullRequestReviewCommand({
      octokit: {},
      pr: pullRequestContext(),
      event_type: 'opened',
      delivery_id: 'delivery-pr-uncertain',
      deps: {
        create_run_id: () => 'run-pr-uncertain',
        start_review: async (args) => {
          args.on_prepared?.({ pr: args.pr, run_id: 'run-pr-uncertain', files: [], workflow: 'pull-request-review', event_type: 'opened' }, { contract_version: 'v5' } as never)
          throw error
        },
        store: {
          admit_review_run: (run) => ({ record: { ...run, status: 'preparing' }, created: true, preparation_token: 'claim' }) as never,
          save_prepared_submission: (run_id, _token, context, input) => transitions.push(['prepared', run_id, context, input]),
          mark_queued: () => assert.fail('uncertain submission must not queue yet'),
          failPreparation: (run_id, _token, failure) => transitions.push([run_id, failure])
        }
      }
    }),
    error
  )

  assert.equal((transitions[0] as unknown[])[0], 'prepared')
  assert.deepEqual(transitions[1], [
    'run-pr-uncertain',
    { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'Runner response was lost.' }
  ])
})

test('startPullRequestReviewCommand admits a comment delivery before loading PR context', async () => {
  const transitions: unknown[] = []

  await assert.rejects(
    startPullRequestReviewCommand({
      octokit: {},
      event_type: 'manual_review',
      delivery_id: 'delivery-context-failure',
      resolve_pr: async () => {
        transitions.push(['context'])
        throw new Error('GitHub PR lookup failed')
      },
      deps: {
        create_run_id: () => 'run-context-failure',
        start_review: async () => assert.fail('review must not start without PR context'),
        store: {
          admit_review_run: (run) => {
            transitions.push(['preparing', run.run_id])
            return { record: { ...run, status: 'preparing' }, created: true, preparation_token: 'claim' } as never
          },
          mark_queued: () => assert.fail('failed context lookup must not queue'),
          failPreparation: (run_id, _token, error) => transitions.push(['failed', run_id, error])
        }
      }
    }),
    /GitHub PR lookup failed/
  )

  assert.deepEqual(transitions, [
    ['preparing', 'run-context-failure'],
    ['context'],
    ['failed', 'run-context-failure', { code: 'REVIEW_START_FAILED', message: 'GitHub PR lookup failed' }]
  ])
})

test('startPullRequestReviewCommand reuses a webhook delivery without starting another review', async () => {
  let starts = 0
  const submitted = await startPullRequestReviewCommand({
    octokit: {},
    pr: pullRequestContext(),
    event_type: 'opened',
    delivery_id: 'delivery-1',
    deps: {
      create_run_id: () => 'run-new',
      start_review: async () => {
        starts += 1
        throw new Error('replayed delivery must not start')
      },
      store: {
        admit_review_run: () => ({
          created: false, preparation_token: null,
          record: { run_id: 'run-original', status: 'queued' } as never
        }),
        mark_queued: () => assert.fail('replayed delivery must not queue again'),
        failPreparation: () => assert.fail('replayed delivery must not change the original run')
      }
    }
  })

  assert.equal(submitted.run_id, 'run-original')
  assert.equal(starts, 0)
})

test('startIssueReviewCommand reuses a webhook delivery without starting another review', async () => {
  let starts = 0
  const submitted = await startIssueReviewCommand({
    octokit: {},
    issue: issueContext(),
    event_type: 'opened',
    delivery_id: 'delivery-issue-1',
    deps: {
      create_run_id: () => 'run-unused',
      start_review: async () => {
        starts += 1
        throw new Error('replayed delivery must not start')
      },
      store: {
        admit_review_run: () => ({
          created: false, preparation_token: null,
          record: { run_id: 'run-original', status: 'queued' } as never
        }),
        mark_queued: () => assert.fail('replayed delivery must not queue again'),
        failPreparation: () => assert.fail('replayed delivery must not change the original run')
      }
    }
  })

  assert.equal(submitted.run_id, 'run-original')
  assert.equal(starts, 0)
})
