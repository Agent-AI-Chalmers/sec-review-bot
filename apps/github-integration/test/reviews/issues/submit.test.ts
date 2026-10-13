import assert from 'node:assert/strict'
import test from 'node:test'

import { startIssueReviewRun } from '../../../src/reviews/issues/submit.js'
import type { IssueContext } from '../../../src/github/issue-service.js'
import type { IssueReviewInput, RepairMode } from '../../../src/runner/input.js'

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
  const calls: Array<{ review_objective: 'audit' | 'repair'; repair_mode?: RepairMode }> = []
  const prepare_input = (async (args: {
    review_objective?: 'audit' | 'repair'
    repair_mode?: RepairMode
  }) => {
    calls.push({
      review_objective: args.review_objective ?? 'audit',
      ...(args.repair_mode ? { repair_mode: args.repair_mode } : {})
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

async function runWith(review_objective: 'audit' | 'repair', repair_mode: RepairMode | null) {
  const { calls, prepare_input } = fakePrepareInput()
  await startIssueReviewRun({
    run_id: 'run-issue-1',
    octokit: {},
    issue: issueContext(),
    event_type: 'manual_review',
    review_objective,
    repair_mode,
    prepare_input,
    on_prepared: async () => {}
  })
  return calls
}

test('audit review forwards an explicit repair_mode to the runner input', async () => {
  // The regression this guards: an issue comment now always audits, but audit can still
  // reach the repair stage, so a user-chosen repair_mode must not be silently dropped.
  assert.deepEqual(await runWith('audit', 'no-test-changes'), [
    { review_objective: 'audit', repair_mode: 'no-test-changes' }
  ])
})

test('audit review without a repair_mode leaves the field absent', async () => {
  assert.deepEqual(await runWith('audit', null), [{ review_objective: 'audit' }])
})

test('repair review keeps its historical default repair_mode', async () => {
  assert.deepEqual(await runWith('repair', null), [
    { review_objective: 'repair', repair_mode: 'test-changes-allowed' }
  ])
})

test('repair review forwards an explicit repair_mode', async () => {
  assert.deepEqual(await runWith('repair', 'no-test-changes'), [
    { review_objective: 'repair', repair_mode: 'no-test-changes' }
  ])
})
