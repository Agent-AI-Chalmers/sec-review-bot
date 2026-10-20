// Covers how a suggestion is shaped into a GitHub review comment.
//
// The subtle rule is the multi-line one: GitHub wants `start_line`/`start_side` only for a span
// that covers more than one line, and rejects a review that repeats the single-line value. Getting
// this wrong turns every single-line suggestion into a failed review.
import assert from 'node:assert/strict'
import test from 'node:test'

import { publishPullRequestSuggestionReview } from '../../../src/reviews/pull-requests/suggestion-comments.js'
import { fakeGitHub, githubJson } from '../../github-client.js'
import { setGitHubAppMetadata } from '../../../src/github/github-app-metadata-service.js'

// Attribution requires the app to know its own bot login; without it a marker lookup fails closed.
setGitHubAppMetadata({ slug: 'sec-review-bot' })

const pr = {
  owner_login: 'octo',
  repo_name: 'example',
  repo_full_name: 'octo/example',
  pr_number: 7,
  pr_author: 'author',
  head_sha: 'head-sha'
}

/** The JSON body of the review the client posted. */
function postedReview(
  requests: Array<{ method: string; url: string; body: unknown }>
) {
  const posted = requests.find(
    (request) =>
      request.method === 'POST' &&
      new URL(request.url).pathname.endsWith('/pulls/7/reviews')
  )
  assert.ok(posted, 'a review must be posted')
  return posted.body as { comments: Array<Record<string, unknown>> }
}

function clients() {
  return fakeGitHub(({ method, url, body }) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/reviews') && method === 'GET') return githubJson([])
    if (pathname.endsWith('/reviews') && method === 'POST') {
      const payload = (body ?? {}) as { comments?: unknown }
      assert.ok(Array.isArray(payload.comments))
      return githubJson({
        id: 11,
        html_url: 'https://example.test/review/11',
        state: 'COMMENTED'
      })
    }
    return githubJson({})
  })
}

test('a single-line suggestion omits start_line and start_side', async () => {
  const { octokit, requests } = clients()
  await publishPullRequestSuggestionReview(octokit, {
    pr,
    review_body: 'body',
    event: 'COMMENT',
    marker: '<!-- run -->',
    candidates: [
      {
        path: 'src/app.ts',
        body: 'suggestion',
        line: 10,
        side: 'RIGHT',
        start_line: 10
      }
    ],
    assert_publication_claim: async () => {}
  })

  const review = postedReview(requests)
  assert.deepStrictEqual(review.comments, [
    { path: 'src/app.ts', body: 'suggestion', line: 10, side: 'RIGHT' }
  ])
})

test('a multi-line suggestion sends start_line and a matching start_side', async () => {
  const { octokit, requests } = clients()
  await publishPullRequestSuggestionReview(octokit, {
    pr,
    review_body: 'body',
    event: 'REQUEST_CHANGES',
    marker: '<!-- run -->',
    candidates: [
      {
        path: 'src/app.ts',
        body: 'suggestion',
        line: 20,
        side: 'LEFT',
        start_line: 15
      }
    ],
    assert_publication_claim: async () => {}
  })

  const review = postedReview(requests)
  assert.deepStrictEqual(review.comments, [
    {
      path: 'src/app.ts',
      body: 'suggestion',
      line: 20,
      side: 'LEFT',
      start_line: 15,
      start_side: 'LEFT'
    }
  ])
})

test('reports the review and one entry per candidate', async () => {
  const { octokit } = clients()
  const result = await publishPullRequestSuggestionReview(octokit, {
    pr,
    review_body: 'body',
    event: 'COMMENT',
    marker: '<!-- run -->',
    candidates: [
      {
        path: 'a.ts',
        body: 'one',
        line: 1,
        side: 'RIGHT',
        start_line: 1
      },
      {
        path: 'b.ts',
        body: 'two',
        line: 5,
        side: 'RIGHT',
        start_line: 3
      }
    ],
    assert_publication_claim: async () => {}
  })

  assert.strictEqual(result.review_id, 11)
  assert.strictEqual(result.html_url, 'https://example.test/review/11')
  assert.strictEqual(result.state, 'COMMENTED')
  assert.strictEqual(result.reused, false)
  assert.strictEqual(result.count, 2)
  assert.deepStrictEqual(result.comments, [
    { path: 'a.ts', line: 1, start_line: 1 },
    { path: 'b.ts', line: 5, start_line: 3 }
  ])
})

test('reuses an existing marked review instead of posting another', async () => {
  const marker = '<!-- run -->'
  const { octokit, requests } = fakeGitHub(({ method, url }) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/reviews') && method === 'GET') {
      return githubJson([
        {
          id: 99,
          body: `${marker}\nold`,
          html_url: 'https://example.test/review/99',
          state: 'COMMENTED',
          // Attribution requires this app's bot login and a Bot entity.
          user: { login: 'sec-review-bot[bot]', type: 'Bot' }
        }
      ])
    }
    throw new Error('no review may be posted when one already exists')
  })

  const result = await publishPullRequestSuggestionReview(octokit, {
    pr,
    review_body: 'body',
    event: 'COMMENT',
    marker,
    candidates: [],
    assert_publication_claim: async () => {}
  })

  assert.strictEqual(result.reused, true)
  assert.strictEqual(result.review_id, 99)
  assert.ok(requests.every((request) => request.url.includes('/reviews')))
})
