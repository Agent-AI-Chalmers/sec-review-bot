import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractIssueContext,
  IssueContextExtractionError
} from '../../infrastructure/github/issue-service.js'
import {
  extractPullRequestContext,
  PullRequestContextExtractionError
} from '../../infrastructure/github/pull-request-service.js'

test('extractIssueContext rejects payloads missing required identity fields', () => {
  assert.throws(
    () => extractIssueContext({}),
    (error: unknown) => error instanceof IssueContextExtractionError &&
      /repository\.name/.test(error.message)
  )
})

test('extractIssueContext returns normalized issue context', () => {
  const context = extractIssueContext({
    action: 'opened',
    repository: {
      name: 'example',
      full_name: 'octo/example',
      owner: { login: 'octo' },
      default_branch: 'main'
    },
    sender: { login: 'alice' },
    issue: {
      number: 12,
      title: 'Example issue',
      body: 'Body',
      user: { login: 'alice' },
      state: 'open',
      labels: [{ name: 'security' }],
      html_url: 'https://example.test/issues/12',
      url: 'https://api.example.test/issues/12',
      comments_url: 'https://api.example.test/issues/12/comments'
    }
  })

  assert.equal(context.repo_full_name, 'octo/example')
  assert.equal(context.issue_number, 12)
  assert.deepEqual(context.labels, ['security'])
})

test('extractPullRequestContext rejects payloads missing required identity fields', () => {
  assert.throws(
    () => extractPullRequestContext({}),
    (error: unknown) => error instanceof PullRequestContextExtractionError &&
      /repository\.name/.test(error.message)
  )
})

test('extractPullRequestContext returns normalized pull request context', () => {
  const context = extractPullRequestContext({
    action: 'opened',
    repository: {
      name: 'example',
      full_name: 'octo/example',
      owner: { login: 'octo' }
    },
    sender: { login: 'alice' },
    pull_request: {
      number: 7,
      title: 'Example PR',
      body: 'Body',
      user: { login: 'alice' },
      draft: false,
      base: {
        ref: 'main',
        sha: 'base-sha',
        repo: { full_name: 'octo/example' }
      },
      head: {
        ref: 'feature',
        sha: 'head-sha',
        repo: { full_name: 'octo/example' }
      }
    }
  })

  assert.equal(context.repo_full_name, 'octo/example')
  assert.equal(context.pr_number, 7)
  assert.equal(context.from_fork, false)
})
