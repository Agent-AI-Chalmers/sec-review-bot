import assert from 'node:assert/strict'
import test from 'node:test'

import { startIssueReviewRun } from '../../../src/reviews/issues/submit.js'
import type { IssueContext } from '../../../src/github/issue-service.js'
import type { IssueReviewInput, TestChangesPolicy } from '../../../src/runner/input.js'

function issueContext(): IssueContext {
  return {
    action: 'opened',
    owner_login: 'octo',
    repo_name: 'example-repo',
    repo_full_name: 'octo/example-repo',
    sender_login: 'alice',
    default_branch: 'main',
    issue_number: 7,
    issue_title: 'Example issue',
    issue_body: 'body',
    issue_author: 'alice',
    issue_state: 'open',
    labels: [],
    html_url: 'https://example.test/issues/7',
    api_url: 'https://api.example.test/issues/7',
    comments_url: 'https://api.example.test/issues/7/comments',
    is_pull_request: false
  }
}

function fakePrepareInput() {
  const calls: Array<{ review_objective: 'audit' | 'repair'; test_changes?: TestChangesPolicy }> =
    []
  const prepare_input = (async (args: {
    review_objective?: 'audit' | 'repair'
    test_changes?: TestChangesPolicy
  }) => {
    calls.push({
      review_objective: args.review_objective ?? 'audit',
      ...(args.test_changes ? { test_changes: args.test_changes } : {})
    })
    return {
      run_id: 'run-issue-1',
      input: { contract_version: 'v5', review_intent: {}, issue: {} } as IssueReviewInput,
      input_path: '/tmp/issue-review-input.json',
      input_bundle_root: '/tmp/bundle',
      workspace_ref: 'workspace-ref'
    }
  }) as never
  return { calls, prepare_input }
}

async function runWith(
  review_objective: 'audit' | 'repair',
  test_changes: TestChangesPolicy | null
) {
  const { calls, prepare_input } = fakePrepareInput()
  await startIssueReviewRun(
    {
      run_id: 'run-issue-1',
      octokit: {},
      issue: issueContext(),
      event_type: 'manual_review',
      review_objective,
      test_changes,
      on_prepared: async () => {}
    },
    { prepare_input }
  )
  return calls
}

test('audit review forwards an explicit test_changes to the runner input', async () => {
  // The regression this guards: an issue comment now always audits, but audit can still
  // reach the repair stage, so a user-chosen test_changes must not be silently dropped.
  assert.deepEqual(await runWith('audit', 'deny'), [
    { review_objective: 'audit', test_changes: 'deny' }
  ])
})

test('audit review without a test_changes leaves the field absent', async () => {
  assert.deepEqual(await runWith('audit', null), [{ review_objective: 'audit' }])
})

test('repair review without a test_changes leaves the field absent', async () => {
  // The runner owns the default (`allow`); the GitHub integration never injects one.
  assert.deepEqual(await runWith('repair', null), [{ review_objective: 'repair' }])
})

test('repair review forwards an explicit test_changes', async () => {
  assert.deepEqual(await runWith('repair', 'deny'), [
    { review_objective: 'repair', test_changes: 'deny' }
  ])
})
