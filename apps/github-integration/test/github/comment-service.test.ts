import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIssueCommentUnlessMarkerExists,
  createPullRequestReviewUnlessMarkerExists
} from '../../src/github/comment-service.js'
import { setGitHubAppMetadata } from '../../src/github/github-app-metadata-service.js'
import type { GitHubAppOctokit } from '../../src/github/octokit.js'
import { PublicationClaimLostError } from '../../src/control-plane/publication-claim.js'

const assertPublicationClaim = async (): Promise<void> => {}

test.beforeEach(() => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
})

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
              user: { login: 'sec-review-bot[bot]', type: 'Bot' }
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
    marker: '<!-- sec-review-bot:repository-summary-run:run-1 -->',
    assert_publication_claim: assertPublicationClaim
  })

  assert.strictEqual(result.id, 123)
  assert.strictEqual(result.reused, true)
  assert.strictEqual(createCalls, 0)
})

test('createIssueCommentUnlessMarkerExists does not reuse another bot marker', async () => {
  let createCalls = 0
  const marker = '<!-- sec-review-bot:repository-summary-run:run-1 -->'
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({
          data: [
            {
              id: 123,
              body: `${marker}\nother bot body`,
              html_url: 'https://example.test/comment/123',
              user: { login: 'other-bot[bot]', type: 'Bot' }
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
    body: `${marker}\nnew body`,
    marker,
    assert_publication_claim: assertPublicationClaim
  })

  assert.strictEqual(result.id, 456)
  assert.strictEqual(result.reused, false)
  assert.strictEqual(createCalls, 1)
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
    marker: '<!-- sec-review-bot:repository-summary-run:run-1 -->',
    assert_publication_claim: assertPublicationClaim
  })

  assert.strictEqual(result.id, 456)
  assert.strictEqual(result.reused, false)
  assert.strictEqual(createCalls, 1)
})

test('issue comment creation stops after marker lookup when publication claim is lost', async () => {
  let createCalls = 0
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => {
          createCalls += 1
          return {
            data: { id: 456, html_url: 'https://example.test/comment/456' }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit

  await assert.rejects(
    createIssueCommentUnlessMarkerExists(octokit, {
      owner_login: 'octo',
      repo_name: 'example',
      issue_number: 1,
      body: 'new body',
      marker: '<!-- run-1 -->',
      assert_publication_claim: async () => {
        throw new PublicationClaimLostError('run-1')
      }
    }),
    PublicationClaimLostError
  )
  assert.strictEqual(createCalls, 0)
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
              user: { login: 'sec-review-bot[bot]', type: 'Bot' }
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
    comments: [],
    assert_publication_claim: assertPublicationClaim
  })

  assert.deepStrictEqual(result, {
    id: 123,
    html_url: 'https://example.test/review/123',
    state: 'CHANGES_REQUESTED',
    reused: true
  })
  assert.strictEqual(createCalls, 0)
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
    comments: [],
    assert_publication_claim: assertPublicationClaim
  })

  assert.strictEqual(result.id, 456)
  assert.strictEqual(result.reused, false)
  assert.strictEqual(createCalls, 1)
})

test('approval fallback rechecks publication ownership before creating a comment review', async () => {
  let createCalls = 0
  let ownershipChecks = 0
  const octokit = {
    rest: {
      pulls: {
        listReviews: async () => ({ data: [] }),
        createReview: async () => {
          createCalls += 1
          if (createCalls === 1) {
            throw {
              response: {
                status: 422,
                data: { message: 'Cannot approve your own pull request' }
              }
            }
          }
          return {
            data: {
              id: 456,
              html_url: 'https://example.test/review/456',
              state: 'COMMENTED'
            }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit

  await createPullRequestReviewUnlessMarkerExists(octokit, {
    owner_login: 'octo',
    repo_name: 'example',
    pr_number: 7,
    commit_id: 'head-sha',
    body: 'review body',
    marker: '<!-- run-1 -->',
    event: 'APPROVE',
    comments: [],
    assert_publication_claim: async () => {
      ownershipChecks += 1
    }
  })

  assert.strictEqual(createCalls, 2)
  assert.strictEqual(ownershipChecks, 2)
})
