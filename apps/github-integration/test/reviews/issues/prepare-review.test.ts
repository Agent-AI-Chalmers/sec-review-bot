import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareIssueReview } from '../../../src/reviews/issues/prepare-review.js'
import type { IssueContext } from '../../../src/github/issue-service.js'
import type {
  IssueReviewInput,
  TestChangesPolicy
} from '../../../src/execution/input.js'
import { EXECUTION_API_VERSION } from '../../../src/execution/execution-api-version.js'
import type { prepareIssueReviewInput } from '../../../src/reviews/issues/prepare-input.js'
import { unusedGitHub } from '../../github-client.js'

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
  const calls: Array<{
    review_objective: 'audit' | 'repair'
    test_changes?: TestChangesPolicy
  }> = []
  // Typed as the real function so the stub cannot drift from its signature; the parameters the
  // test does not assert on are accepted and ignored.
  const prepare_input: typeof prepareIssueReviewInput = async (args) => {
    calls.push({
      review_objective: args.review_objective ?? 'audit',
      ...(args.test_changes ? { test_changes: args.test_changes } : {})
    })
    return {
      run_id: 'run-issue-1',
      input: {
        api_version: EXECUTION_API_VERSION,
        review_intent: {},
        issue: {}
      } as IssueReviewInput,
      input_path: '/tmp/issue-review-input.json',
      input_bundle_root: '/tmp/bundle',
      workspace_ref: 'workspace-ref'
    }
  }
  return { calls, prepare_input }
}

async function runWith(
  review_objective: 'audit' | 'repair',
  test_changes: TestChangesPolicy | null
) {
  const { calls, prepare_input } = fakePrepareInput()
  const prepared = await prepareIssueReview(
    {
      run_id: 'run-issue-1',
      octokit: unusedGitHub().octokit,
      issue: issueContext(),
      trusted_default_branch: {
        default_branch: 'main',
        head_sha: 'default-sha'
      },
      event_type: 'manual_review',
      review_objective,
      test_changes
    },
    { prepare_input }
  )
  assert.deepStrictEqual(prepared.review, {
    issue: issueContext(),
    run_id: 'run-issue-1',
    workspace_ref: 'workspace-ref',
    workflow: 'issue-review',
    event_type: 'manual_review',
    open_pr: false
  })
  assert.strictEqual(prepared.input.api_version, EXECUTION_API_VERSION)
  return calls
}

test('audit review forwards an explicit test_changes to the execution input', async () => {
  // The regression this guards: an issue comment now always audits, but audit can still
  // reach the repair stage, so a user-chosen test_changes must not be silently dropped.
  assert.deepStrictEqual(await runWith('audit', 'deny'), [
    { review_objective: 'audit', test_changes: 'deny' }
  ])
})

test('audit review without a test_changes leaves the field absent', async () => {
  assert.deepStrictEqual(await runWith('audit', null), [
    { review_objective: 'audit' }
  ])
})

test('repair review without a test_changes leaves the field absent', async () => {
  // The Execution Worker owns the default (`allow`); the GitHub integration never injects one.
  assert.deepStrictEqual(await runWith('repair', null), [
    { review_objective: 'repair' }
  ])
})

test('repair review forwards an explicit test_changes', async () => {
  assert.deepStrictEqual(await runWith('repair', 'deny'), [
    { review_objective: 'repair', test_changes: 'deny' }
  ])
})
