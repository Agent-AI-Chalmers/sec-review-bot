import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIssueCommentUnlessMarkerExists,
  createPullRequestReviewUnlessMarkerExists
} from '../../src/infrastructure/github/comment-service.js'
import type { GitHubAppOctokit } from '../../src/infrastructure/github/octokit.js'

test('createIssueCommentUnlessMarkerExists skips creation when marker already exists', async () => {
  let createCalls = 0
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({
          data: [
            {
              id: 123,
              body: '<!-- sec-review-bot:repository-summary-run:run-1 -->\nold body',
              html_url: 'https://example.test/comment/123',
              user: { type: 'Bot' }
            }
          ]
        }),
        createComment: async () => {
          createCalls += 1
          return {
            data: {
              id: 456,
              html_url: 'https://example.test/comment/456'
            }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit

  const result = await createIssueCommentUnlessMarkerExists(octokit, {
    owner_login: 'octo',
    repo_name: 'example',
    issue_number: 1,
    body: '<!-- sec-review-bot:repository-summary-run:run-1 -->\nnew body',
    marker: '<!-- sec-review-bot:repository-summary-run:run-1 -->'
  })

  assert.equal(result.id, 123)
  assert.equal(result.reused, true)
  assert.equal(createCalls, 0)
})

test('createIssueCommentUnlessMarkerExists creates when marker is absent', async () => {
  let createCalls = 0
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({
          data: []
        }),
        createComment: async () => {
          createCalls += 1
          return {
            data: {
              id: 456,
              html_url: 'https://example.test/comment/456'
            }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit

  const result = await createIssueCommentUnlessMarkerExists(octokit, {
    owner_login: 'octo',
    repo_name: 'example',
    issue_number: 1,
    body: '<!-- sec-review-bot:repository-summary-run:run-1 -->\nbody',
    marker: '<!-- sec-review-bot:repository-summary-run:run-1 -->'
  })

  assert.equal(result.id, 456)
  assert.equal(result.reused, false)
  assert.equal(createCalls, 1)
})

test('createPullRequestReviewUnlessMarkerExists reuses a marked bot review', async () => {
  let createCalls = 0
  const marker = '<!-- sec-review-bot:pull-request-review-run:run-1 -->'
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({
          data: [
            {
              id: 123,
              body: `${marker}\nold body`,
              html_url: 'https://example.test/review/123',
              state: 'CHANGES_REQUESTED',
              user: { type: 'Bot' }
            }
          ]
        }),
        createReview: async () => {
          createCalls += 1
          throw new Error('createReview should not be called')
        }
      }
    }
  } as unknown as GitHubAppOctokit

  const result = await createPullRequestReviewUnlessMarkerExists(octokit, {
    owner_login: 'octo',
    repo_name: 'example',
    pr_number: 7,
    commit_id: 'head-sha',
    body: `${marker}\nnew body`,
    marker,
    event: 'REQUEST_CHANGES',
    comments: []
  })

  assert.deepEqual(result, {
    id: 123,
    html_url: 'https://example.test/review/123',
    state: 'CHANGES_REQUESTED',
    reused: true
  })
  assert.equal(createCalls, 0)
})

test('createPullRequestReviewUnlessMarkerExists creates when marker is absent', async () => {
  let createCalls = 0
  const marker = '<!-- sec-review-bot:pull-request-review-run:run-1 -->'
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async () => {
          createCalls += 1
          return {
            data: {
              id: 456,
              html_url: 'https://example.test/review/456',
              state: 'CHANGES_REQUESTED'
            }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit

  const result = await createPullRequestReviewUnlessMarkerExists(octokit, {
    owner_login: 'octo',
    repo_name: 'example',
    pr_number: 7,
    commit_id: 'head-sha',
    body: `${marker}\nbody`,
    marker,
    event: 'REQUEST_CHANGES',
    comments: []
  })

  assert.equal(result.id, 456)
  assert.equal(result.reused, false)
  assert.equal(createCalls, 1)
})
