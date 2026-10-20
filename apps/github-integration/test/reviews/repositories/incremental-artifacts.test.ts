// Covers the ancestry check used to decide whether an incremental scan's base is still reachable
// from its head. Getting this wrong would either rescan the whole history or trust a stale base.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isAncestorCommit } from '../../../src/reviews/repositories/incremental-artifacts.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

const repo = {
  owner_login: 'octo',
  repo_name: 'example',
  repo_full_name: 'octo/example',
  default_branch: 'main'
}

test('reports an ancestor when GitHub compares the head as "ahead"', async () => {
  const { octokit, requests } = fakeGitHub(() =>
    githubJson({ status: 'ahead' })
  )
  assert.strictEqual(
    await isAncestorCommit({
      octokit,
      repo,
      base_sha: 'base123',
      head_sha: 'head456'
    }),
    true
  )
  // The comparison is addressed by `base...head` on the compare endpoint.
  assert.strictEqual(requests.length, 1)
  assert.match(
    decodeURIComponent(new URL(requests[0]!.url).pathname),
    /\/repos\/octo\/example\/compare\/base123\.\.\.head456$/
  )
})

test('treats any status other than "ahead" as not an ancestor', async () => {
  // `diverged`, `behind`, and `identical` all mean the base is not an ancestor of the head.
  for (const status of ['diverged', 'behind', 'identical', '', 'unknown']) {
    const { octokit } = fakeGitHub(() => githubJson({ status }))
    assert.strictEqual(
      await isAncestorCommit({
        octokit,
        repo,
        base_sha: 'base123',
        head_sha: 'head456'
      }),
      false,
      `${JSON.stringify(status)} must not be treated as an ancestor`
    )
  }
})

test('normalizes the status before comparing it', async () => {
  const { octokit } = fakeGitHub(() => githubJson({ status: ' AHEAD ' }))
  assert.strictEqual(
    await isAncestorCommit({
      octokit,
      repo,
      base_sha: 'b',
      head_sha: 'h'
    }),
    true
  )
})

test('treats a missing status as not an ancestor', async () => {
  const { octokit } = fakeGitHub(() => githubJson({}))
  assert.strictEqual(
    await isAncestorCommit({ octokit, repo, base_sha: 'b', head_sha: 'h' }),
    false
  )
})

test('propagates a compare failure instead of guessing', async () => {
  // A failed comparison must not be read as "not an ancestor": the caller has to decide.
  const { octokit } = fakeGitHub(() =>
    githubJson({ message: 'Not Found' }, 404)
  )
  await assert.rejects(
    () => isAncestorCommit({ octokit, repo, base_sha: 'b', head_sha: 'h' }),
    (error: { status?: number }) => error.status === 404
  )
})
