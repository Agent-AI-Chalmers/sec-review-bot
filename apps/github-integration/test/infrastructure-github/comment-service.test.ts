import assert from 'node:assert/strict'
import test from 'node:test'

import { createIssueCommentUnlessMarkerExists } from '../../infrastructure/github/comment-service.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'

test('createIssueCommentUnlessMarkerExists skips creation when marker already exists', async () => {
  let createCalls = 0
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({
          data: [{
            id: 123,
            body: '<!-- sec-review-bot:repository-summary-run:run-1 -->\nold body',
            html_url: 'https://example.test/comment/123',
            user: { type: 'Bot' }
          }]
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
