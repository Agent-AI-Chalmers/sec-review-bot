import assert from 'node:assert/strict'
import test from 'node:test'

import { extractIssueContext, IssueContextExtractionError } from '../../src/github/issue-service.js'
import {
  extractPullRequestContext,
  PullRequestContextExtractionError
} from '../../src/github/pull-request-service.js'

test('extractIssueContext rejects payloads missing required identity fields', () => {
  assert.throws(
    () => extractIssueContext({}),
    (error: unknown) =>
      error instanceof IssueContextExtractionError && /repository\.name/.test(error.message)
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
    (error: unknown) =>
      error instanceof PullRequestContextExtractionError && /repository\.name/.test(error.message)
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

test('extractPullRequestContext keeps trusted identity on the base repo for fork PRs', () => {
  // Fork PR: the top-level `repository` field is the BASE repository (where the
  // event occurred), while pull_request.head.repo is the contributor's fork.
  // The setup declaration must be read from the base repo, never the head/fork repo.
  const context = extractPullRequestContext({
    action: 'opened',
    repository: {
      name: 'example',
      full_name: 'octo/example',
      owner: { login: 'octo' }
    },
    sender: { login: 'mallory' },
    pull_request: {
      number: 9,
      title: 'Fork PR',
      body: 'Body',
      user: { login: 'mallory' },
      draft: false,
      base: {
        ref: 'main',
        sha: 'base-sha',
        repo: { full_name: 'octo/example' }
      },
      head: {
        ref: 'feature',
        sha: 'head-sha',
        repo: { full_name: 'mallory/example' }
      }
    }
  })

  assert.equal(context.from_fork, true)
  assert.equal(context.repo_full_name, 'octo/example')
  assert.equal(context.base_repo_full_name, 'octo/example')
  assert.equal(context.head_repo_full_name, 'mallory/example')
  // Trusted ref must resolve from the base repo identity, not the head/fork.
  assert.notEqual(context.repo_full_name, context.head_repo_full_name)
})

test('extractPullRequestContext treats a missing repo identity as a fork (fail closed)', () => {
  // `from_fork` is a trust gate: it decides whether the run is auto-skipped for
  // maintainer approval. If either repository identity is absent we cannot prove
  // "same repository", so the PR must be treated as a fork rather than silently
  // auto-reviewed. The old `head !== base` comparison made two nulls equal and
  // thus reported a same-repo PR.
  const context = extractPullRequestContext({
    action: 'opened',
    repository: {
      name: 'example',
      full_name: 'octo/example',
      owner: { login: 'octo' }
    },
    sender: { login: 'alice' },
    pull_request: {
      number: 11,
      title: 'No repo identity',
      body: '',
      user: { login: 'alice' },
      draft: false,
      base: { ref: 'main', sha: 'base-sha' },
      head: { ref: 'feature', sha: 'head-sha' }
    }
  })

  assert.equal(context.from_fork, true)
  assert.equal(context.base_repo_full_name, null)
  assert.equal(context.head_repo_full_name, null)
})
