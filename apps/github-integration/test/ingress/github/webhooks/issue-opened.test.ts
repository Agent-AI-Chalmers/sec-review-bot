import assert from 'node:assert/strict'
import test from 'node:test'

import { handleIssueOpenedWithDeps } from '../../../../src/ingress/github/webhooks/issue-opened.js'
import { setGitHubAppMetadata } from '../../../../src/github/github-app-metadata-service.js'
import { RepositoryTriggerConfigError } from '../../../../src/github/repo-config-service.js'
import { unusedGitHub } from '../../../github-client.js'

function automaticConfig() {
  return {
    trigger_mode: 'automatic' as const,
    paths_ignore: [],
    path: '.sec-review/config.yml',
    ref: 'main',
    source: 'repository-config' as const
  }
}

function manualOnlyConfig() {
  return {
    trigger_mode: 'manual_only' as const,
    paths_ignore: [],
    path: '.sec-review/config.yml',
    ref: 'main',
    source: 'repository-config' as const
  }
}

function trusted(
  config:
    ReturnType<typeof automaticConfig> | ReturnType<typeof manualOnlyConfig>
) {
  return { config, default_branch: 'main', head_sha: 'main-sha' }
}

function createIssueOpenedPayload() {
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
      id: 'delivery-test',
      octokit: unusedGitHub().octokit,
      payload: createIssueOpenedPayload()
    },
    {
      fetchTrustedRepositoryTriggerConfigFn: async () =>
        trusted(manualOnlyConfig()),
      isAutomaticTriggerModeEnabledFn: () => false,
      startIssueReviewCommandFn: async () => {
        reviewCalled = true
      }
    }
  )

  assert.strictEqual(reviewCalled, false)
})

test('issue-opened skips self-originated payload before issue extraction', async () => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
  try {
    let configFetched = false

    await handleIssueOpenedWithDeps(
      {
        id: 'delivery-test',
        octokit: unusedGitHub().octokit,
        payload: {
          sender: {
            login: 'sec-review-bot[bot]',
            type: 'Bot'
          }
        }
      },
      {
        fetchTrustedRepositoryTriggerConfigFn: async () => {
          configFetched = true
          return trusted(manualOnlyConfig())
        }
      }
    )

    assert.strictEqual(configFetched, false)
  } finally {
    setGitHubAppMetadata()
  }
})

test('issue-opened runs automatic workflow when trigger mode is automatic', async () => {
  let reviewCalled = false
  let forwarded: { default_branch: string; head_sha: string } | null = null

  await handleIssueOpenedWithDeps(
    {
      id: 'delivery-test',
      octokit: unusedGitHub().octokit,
      payload: createIssueOpenedPayload()
    },
    {
      fetchTrustedRepositoryTriggerConfigFn: async () =>
        trusted(automaticConfig()),
      isAutomaticTriggerModeEnabledFn: () => true,
      startIssueReviewCommandFn: async ({ trusted_default_branch }) => {
        reviewCalled = true
        forwarded = trusted_default_branch
      }
    }
  )

  assert.strictEqual(reviewCalled, true)
  // The resolved trusted branch is forwarded to the command (wiring pinned).
  assert.deepStrictEqual(forwarded, {
    default_branch: 'main',
    head_sha: 'main-sha'
  })
})

test('issue-opened rethrows invalid repository trigger config error', async () => {
  const configError = new RepositoryTriggerConfigError('bad config', {
    owner_login: 'octo',
    repo_name: 'example-repo',
    ref: 'main',
    path: '.sec-review/config.yml',
    reason: 'invalid-yaml'
  })

  await assert.rejects(
    handleIssueOpenedWithDeps(
      {
        id: 'delivery-test',
        octokit: unusedGitHub().octokit,
        payload: createIssueOpenedPayload()
      },
      {
        fetchTrustedRepositoryTriggerConfigFn: async () => {
          throw configError
        },
        isRepositoryTriggerConfigErrorFn: (
          error
        ): error is RepositoryTriggerConfigError => Boolean(error)
      }
    ),
    configError
  )
})
