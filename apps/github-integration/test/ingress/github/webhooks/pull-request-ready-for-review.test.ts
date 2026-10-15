import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePullRequestReadyForReviewWithDeps } from '../../../../src/ingress/github/webhooks/pull-request-ready-for-review.js'

function createPayload({ fromFork = false } = {}) {
  return {
    action: 'ready_for_review',
    repository: {
      name: 'example-repo',
      full_name: 'octo/example-repo',
      owner: { login: 'octo' }
    },
    sender: { login: 'alice' },
    pull_request: {
      number: 7,
      title: 'Improve security checks',
      body: 'Body',
      user: { login: 'alice' },
      draft: false,
      base: {
        ref: 'main',
        sha: 'base-sha',
        repo: { full_name: 'octo/example-repo' }
      },
      head: {
        ref: 'feature',
        sha: 'head-sha',
        repo: {
          full_name: fromFork ? 'mallory/example-repo' : 'octo/example-repo'
        }
      },
      commits: 1,
      changed_files: 1,
      additions: 10,
      deletions: 2,
      html_url: 'https://example.test/pull/7',
      url: 'https://api.example.test/pulls/7',
      commits_url: 'https://api.example.test/pulls/7/commits',
      review_comments_url: 'https://api.example.test/pulls/7/comments',
      comments_url: 'https://api.example.test/issues/7/comments',
      issue_url: 'https://api.example.test/issues/7'
    }
  }
}

function automaticResolution() {
  return {
    config: {
      trigger_mode: 'automatic' as const,
      paths_ignore: [],
      path: '.sec-review/config.yml',
      ref: 'main',
      source: 'repository-config' as const
    },
    default_branch: 'main',
    head_sha: 'main-sha'
  }
}

test('skips fork PRs on ready_for_review; approval is an explicit comment command', async () => {
  let reviewStarted = false
  let configFetched = false

  await handlePullRequestReadyForReviewWithDeps(
    {
      id: 'delivery-fork-ready',
      octokit: {},
      payload: createPayload({ fromFork: true })
    },
    {
      fetchTrustedRepositoryTriggerConfigFn: async () => {
        configFetched = true
        return automaticResolution()
      },
      isAutomaticTriggerModeEnabledFn: () => true,
      startPullRequestReviewCommandFn: async () => {
        reviewStarted = true
        return { run_id: 'run-1', status: 'admitted' }
      }
    }
  )

  assert.strictEqual(
    reviewStarted,
    false,
    'fork PR must not auto-review on ready_for_review'
  )
  assert.strictEqual(configFetched, false)
})

test('does not start a review when automatic mode is disabled', async () => {
  let reviewStarted = false

  await handlePullRequestReadyForReviewWithDeps(
    { id: 'delivery-manual', octokit: {}, payload: createPayload() },
    {
      fetchTrustedRepositoryTriggerConfigFn: async () => automaticResolution(),
      isAutomaticTriggerModeEnabledFn: () => false,
      startPullRequestReviewCommandFn: async () => {
        reviewStarted = true
      }
    }
  )

  assert.strictEqual(reviewStarted, false)
})
