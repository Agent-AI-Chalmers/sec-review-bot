import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePullRequestSynchronizeWithDeps } from '../../../../src/ingress/github/webhooks/pull-request-synchronize.js'

function createPayload({ fromFork = false, draft = false } = {}) {
  return {
    action: 'synchronize',
    before: 'old-head-sha',
    after: 'head-sha',
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
      draft,
      base: {
        ref: 'main',
        sha: 'base-sha',
        repo: { full_name: 'octo/example-repo' }
      },
      head: {
        ref: 'feature',
        sha: 'head-sha',
        repo: { full_name: fromFork ? 'mallory/example-repo' : 'octo/example-repo' }
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

test('skip automatic review for fork PRs before fetching config or starting a review', async () => {
  let configFetched = false
  let reviewStarted = false

  await handlePullRequestSynchronizeWithDeps(
    { id: 'delivery-fork-sync', octokit: {}, payload: createPayload({ fromFork: true }) },
    {
      fetchTrustedRepositoryTriggerConfigFn: async () => {
        configFetched = true
        throw new Error('should not be called')
      },
      startPullRequestReviewCommandFn: async () => {
        reviewStarted = true
      }
    }
  )

  assert.equal(configFetched, false)
  assert.equal(reviewStarted, false)
})

test('reads trigger config from the trusted default branch resolved by the API', async () => {
  let fetchedIdentity: { owner_login: string; repo_name: string } | null = null

  await handlePullRequestSynchronizeWithDeps(
    { id: 'delivery-same-repo', octokit: {}, payload: createPayload({ fromFork: false }) },
    {
      fetchTrustedRepositoryTriggerConfigFn: async (_octokit, identity) => {
        fetchedIdentity = identity
        return {
          config: {
            trigger_mode: 'manual_only' as const,
            paths_ignore: [],
            path: '.sec-review/config.yml',
            ref: 'main',
            source: 'repository-config' as const
          },
          default_branch: 'main',
          head_sha: 'main-sha'
        }
      },
      isAutomaticTriggerModeEnabledFn: () => false
    }
  )

  assert.deepEqual(fetchedIdentity, { owner_login: 'octo', repo_name: 'example-repo' })
})

test('starts a review for same-repo PRs when automatic mode is enabled', async () => {
  let reviewStarted = false

  await handlePullRequestSynchronizeWithDeps(
    { id: 'delivery-auto', octokit: {}, payload: createPayload({ fromFork: false }) },
    {
      fetchTrustedRepositoryTriggerConfigFn: async () => ({
        config: {
          trigger_mode: 'automatic' as const,
          paths_ignore: [],
          path: '.sec-review/config.yml',
          ref: 'main',
          source: 'repository-config' as const
        },
        default_branch: 'main',
        head_sha: 'main-sha'
      }),
      isAutomaticTriggerModeEnabledFn: () => true,
      startPullRequestReviewCommandFn: async () => {
        reviewStarted = true
        return { run_id: 'run-1', status: 'admitted' }
      }
    }
  )

  assert.equal(reviewStarted, true)
})
