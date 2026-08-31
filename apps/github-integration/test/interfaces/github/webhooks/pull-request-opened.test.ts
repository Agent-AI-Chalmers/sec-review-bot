import assert from 'node:assert/strict'
import test from 'node:test'

import { handlePullRequestOpenedWithDeps } from '../../../../interfaces/github/webhooks/pull-request-opened.js'
import { setGitHubAppMetadata } from '../../../../infrastructure/github/github-app-metadata-service.js'
import { RepositoryTriggerConfigError } from '../../../../infrastructure/github/repo-config-service.js'

function automaticConfig () {
  return {
    trigger_mode: 'automatic' as const,
    paths_ignore: [],
    path: '.github/sec-review-bot.yml',
    ref: 'main',
    source: 'repository-config' as const
  }
}

function manualOnlyConfig () {
  return {
    trigger_mode: 'manual_only' as const,
    paths_ignore: [],
    path: '.github/sec-review-bot.yml',
    ref: 'main',
    source: 'repository-config' as const
  }
}

function createPullRequestOpenedPayload ({ draft = false } = {}) {
  return {
    action: 'opened',
    before: null,
    repository: {
      name: 'example-repo',
      full_name: 'octo/example-repo',
      owner: {
        login: 'octo'
      }
    },
    sender: {
      login: 'alice'
    },
    pull_request: {
      number: 7,
      title: 'Improve security checks',
      body: 'Body',
      user: {
        login: 'alice'
      },
      draft,
      base: {
        ref: 'main',
        sha: 'base-sha',
        repo: {
          full_name: 'octo/example-repo'
        }
      },
      head: {
        ref: 'feature',
        sha: 'head-sha',
        repo: {
          full_name: 'octo/example-repo'
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

test('pull-request-opened skips automatic workflow when trigger mode is manual_only', async () => {
  let reviewCalled = false

  await handlePullRequestOpenedWithDeps(
    {
      octokit: {},
      payload: createPullRequestOpenedPayload()
    },
    {
      fetchRepositoryTriggerConfigFn: async () => manualOnlyConfig(),
      isAutomaticTriggerModeEnabledFn: () => false,
      startPullRequestReviewCommandFn: async () => {
        reviewCalled = true
      }
    }
  )

  assert.equal(reviewCalled, false)
})

test('pull-request-opened skips self-originated payload before pull request extraction', async () => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
  try {
    let configFetched = false

    await handlePullRequestOpenedWithDeps(
      {
        octokit: {},
        payload: {
          sender: {
            login: 'sec-review-bot[bot]',
            type: 'Bot'
          }
        }
      },
      {
        fetchRepositoryTriggerConfigFn: async () => {
          configFetched = true
          return manualOnlyConfig()
        }
      }
    )

    assert.equal(configFetched, false)
  } finally {
    setGitHubAppMetadata()
  }
})

test('pull-request-opened runs automatic workflow when trigger mode is automatic', async () => {
  let reviewCalled = false

  await handlePullRequestOpenedWithDeps(
    {
      octokit: {},
      payload: createPullRequestOpenedPayload()
    },
    {
      fetchRepositoryTriggerConfigFn: async () => automaticConfig(),
      isAutomaticTriggerModeEnabledFn: () => true,
      startPullRequestReviewCommandFn: async () => {
        reviewCalled = true
      }
    }
  )

  assert.equal(reviewCalled, true)
})

test('pull-request-opened rethrows invalid repository trigger config error', async () => {
  const configError = new RepositoryTriggerConfigError('bad config', {
    owner_login: 'octo',
    repo_name: 'example-repo',
    ref: 'main',
    path: '.github/sec-review-bot.yml',
    reason: 'invalid-trigger-mode'
  })

  await assert.rejects(
    handlePullRequestOpenedWithDeps(
      {
        octokit: {},
        payload: createPullRequestOpenedPayload()
      },
      {
        fetchRepositoryTriggerConfigFn: async () => {
          throw configError
        },
        isRepositoryTriggerConfigErrorFn: (error): error is RepositoryTriggerConfigError => Boolean(error)
      }
    ),
    configError
  )
})
