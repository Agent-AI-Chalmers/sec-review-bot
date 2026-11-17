import { expect, test } from 'vitest'

import {
  extractIssueContext,
  IssueContextExtractionError
} from '../../src/github/issue-service.js'
import {
  extractPullRequestContext,
  PullRequestContextExtractionError
} from '../../src/github/pull-request-service.js'

test('extractIssueContext rejects payloads missing required identity fields', () => {
  expect(() => extractIssueContext({})).toThrow(
    expect.toSatisfy(
      (error: unknown) =>
        error instanceof IssueContextExtractionError &&
        /repository\.name/.test(error.message)
    )
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

  expect(context.repo_full_name).toBe('octo/example')
  expect(context.issue_number).toBe(12)
  expect(context.labels).toStrictEqual(['security'])
})

test('extractPullRequestContext rejects payloads missing required identity fields', () => {
  expect(() => extractPullRequestContext({})).toThrow(
    expect.toSatisfy(
      (error: unknown) =>
        error instanceof PullRequestContextExtractionError &&
        /repository\.name/.test(error.message)
    )
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

  expect(context.repo_full_name).toBe('octo/example')
  expect(context.pr_number).toBe(7)
  expect(context.from_fork).toBe(false)
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

  expect(context.from_fork).toBe(true)
  expect(context.repo_full_name).toBe('octo/example')
  expect(context.base_repo_full_name).toBe('octo/example')
  expect(context.head_repo_full_name).toBe('mallory/example')
  // Trusted ref must resolve from the base repo identity, not the head/fork.
  expect(context.repo_full_name).not.toBe(context.head_repo_full_name)
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

  expect(context.from_fork).toBe(true)
  expect(context.base_repo_full_name).toBe(null)
  expect(context.head_repo_full_name).toBe(null)
})
