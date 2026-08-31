import assert from 'node:assert/strict'
import test from 'node:test'

import { handleIssueOpenedWithDeps } from '../../../../interfaces/github/webhooks/issue-opened.js'
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

function createIssueOpenedPayload () {
  return {
    action: 'opened',
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
    issue: {
      number: 12,
      title: 'Example issue',
      body: 'Body',
      state: 'open',
      user: {
        login: 'alice'
      },
      labels: [],
      html_url: 'https://example.test/issues/12',
      url: 'https://api.example.test/issues/12',
      comments_url: 'https://api.example.test/issues/12/comments'
    }
  }
}

test('issue-opened skips automatic workflow when trigger mode is manual_only', async () => {
  let reviewCalled = false

  await handleIssueOpenedWithDeps(
    {
      octokit: {},
      payload: createIssueOpenedPayload()
    },
    {
      fetchRepositoryTriggerConfigFn: async () => manualOnlyConfig(),
      isAutomaticTriggerModeEnabledFn: () => false,
      startIssueReviewCommandFn: async () => {
        reviewCalled = true
      }
    }
  )

  assert.equal(reviewCalled, false)
})

test('issue-opened skips self-originated payload before issue extraction', async () => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
  try {
    let configFetched = false

    await handleIssueOpenedWithDeps(
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

test('issue-opened runs automatic workflow when trigger mode is automatic', async () => {
  let reviewCalled = false

  await handleIssueOpenedWithDeps(
    {
      octokit: {},
      payload: createIssueOpenedPayload()
    },
    {
      fetchRepositoryTriggerConfigFn: async () => automaticConfig(),
      isAutomaticTriggerModeEnabledFn: () => true,
      startIssueReviewCommandFn: async () => {
        reviewCalled = true
      }
    }
  )

  assert.equal(reviewCalled, true)
})

test('issue-opened rethrows invalid repository trigger config error', async () => {
  const configError = new RepositoryTriggerConfigError('bad config', {
    owner_login: 'octo',
    repo_name: 'example-repo',
    ref: 'main',
    path: '.github/sec-review-bot.yml',
    reason: 'invalid-yaml'
  })

  await assert.rejects(
    handleIssueOpenedWithDeps(
      {
        octokit: {},
        payload: createIssueOpenedPayload()
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
