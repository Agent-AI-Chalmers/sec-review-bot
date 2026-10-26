import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIssueCommentUnlessMarkerExists,
  createPullRequestReviewUnlessMarkerExists
} from '../../src/github/comment-service.js'
import { setGitHubAppMetadata } from '../../src/github/github-app-metadata-service.js'
import { PublicationClaimLostError } from '../../src/review-runs/publication-claim.js'
import { fakeGitHub, githubJson } from '../github-client.js'

/** Records how many times a comment- or review-creating request reached the API. */
function countingGitHub(respond: Parameters<typeof fakeGitHub>[0]) {
  const counts = { createComment: 0, createReview: 0 }
  const harness = fakeGitHub((request) => {
    if (request.method === 'POST') {
      const path = new URL(request.url).pathname
      if (/\/comments$/.test(path)) counts.createComment += 1
      if (/\/reviews$/.test(path)) counts.createReview += 1
    }
    return respond(request)
  })
  return { ...harness, counts }
}

const assertPublicationClaim = async (): Promise<void> => {}

test.beforeEach(() => {
  setGitHubAppMetadata({ slug: 'sec-review-bot' })
})

test('createIssueCommentUnlessMarkerExists skips creation when marker already exists', async () => {
  const { octokit, counts } = countingGitHub(({ method }) => {
    if (method === 'GET')
      return githubJson([
        {
          id: 123,
          body: '<!-- sec-review-bot:repository-summary-run:run-1 -->\nold body',
          html_url: 'https://example.test/comment/123',
          user: { login: 'sec-review-bot[bot]', type: 'Bot' }
        }
      ])
    return githubJson({ id: 456, html_url: 'https://example.test/comment/456' })
  })

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
  assert.strictEqual(counts.createComment, 0)
})

test('createIssueCommentUnlessMarkerExists does not reuse another bot marker', async () => {
  const marker = '<!-- sec-review-bot:repository-summary-run:run-1 -->'
  const { octokit, counts } = countingGitHub(({ method }) => {
    if (method === 'GET')
      return githubJson([
        {
          id: 123,
          body: `${marker}\nother bot body`,
          html_url: 'https://example.test/comment/123',
          user: { login: 'other-bot[bot]', type: 'Bot' }
        }
      ])
    return githubJson({ id: 456, html_url: 'https://example.test/comment/456' })
  })

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
  assert.strictEqual(counts.createComment, 1)
})

test('createIssueCommentUnlessMarkerExists creates when marker is absent', async () => {
  const { octokit, counts } = countingGitHub(({ method }) =>
    method === 'GET'
      ? githubJson([])
      : githubJson({ id: 456, html_url: 'https://example.test/comment/456' })
  )

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
  assert.strictEqual(counts.createComment, 1)
})

test('issue comment creation stops after marker lookup when publication claim is lost', async () => {
  const { octokit, counts } = countingGitHub(({ method }) =>
    method === 'GET'
      ? githubJson([])
      : githubJson({ id: 456, html_url: 'https://example.test/comment/456' })
  )

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
  assert.strictEqual(counts.createComment, 0)
})

test('createPullRequestReviewUnlessMarkerExists reuses a marked bot review', async () => {
  const marker = '<!-- sec-review-bot:pull-request-review-run:run-1 -->'
  const { octokit, counts } = countingGitHub(({ method }) => {
    if (method === 'GET')
      return githubJson([
        {
          id: 123,
          body: `${marker}\nold body`,
          html_url: 'https://example.test/review/123',
          state: 'CHANGES_REQUESTED',
          user: { login: 'sec-review-bot[bot]', type: 'Bot' }
        }
      ])
    throw new Error('createReview should not be called')
  })

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
  assert.strictEqual(counts.createReview, 0)
})

test('createPullRequestReviewUnlessMarkerExists creates when marker is absent', async () => {
  const marker = '<!-- sec-review-bot:pull-request-review-run:run-1 -->'
  const { octokit, counts } = countingGitHub(({ method }) =>
    method === 'GET'
      ? githubJson([])
      : githubJson({
          id: 456,
          html_url: 'https://example.test/review/456',
          state: 'CHANGES_REQUESTED'
        })
  )

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
  assert.strictEqual(counts.createReview, 1)
})

test('approval fallback rechecks publication ownership before creating a comment review', async () => {
  let ownershipChecks = 0
  let reviewAttempts = 0
  const { octokit, counts } = countingGitHub(({ method }) => {
    if (method === 'GET') return githubJson([])
    reviewAttempts += 1
    // The first attempt is rejected the way GitHub rejects approving your own PR. Returning a
    // response (rather than throwing) is what a real API does, so Octokit maps it to a
    // RequestError with status 422 and the code under test takes its fallback path.
    if (reviewAttempts === 1)
      return githubJson(
        { message: 'Cannot approve your own pull request' },
        422
      )
    return githubJson({
      id: 456,
      html_url: 'https://example.test/review/456',
      state: 'COMMENTED'
    })
  })

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

  assert.strictEqual(counts.createReview, 2)
  assert.strictEqual(ownershipChecks, 2)
})
