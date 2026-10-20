// Covers the guard around `octokit.auth({ type: 'installation' })`.
//
// The SDK types `auth()` as returning `unknown`, so a thrown token field or a non-object result is
// representable and must not escape as an empty git credential. These cases pin the guard that
// turns each into a single, explicit error.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Octokit } from 'octokit'

import { getInstallationAccessToken } from '../../src/github/installation-auth.js'
import { fakeGitHub, githubJson } from '../github-client.js'

/** A real client whose `auth()` answers `result`; only the auth hook is replaced, so the type
 * stays the SDK's and no hand-made object is cast into it. */
function octokitReturning(result: unknown): Octokit {
  const { octokit } = fakeGitHub(() => githubJson({}))
  octokit.auth = (async () => result) as typeof octokit.auth
  return octokit
}

test('returns the trimmed installation token', async () => {
  const token = await getInstallationAccessToken(
    octokitReturning({ token: '  ghs_abc123  ' })
  )
  assert.strictEqual(token, 'ghs_abc123')
})

test('rejects a non-object auth result', async () => {
  // `auth()` is typed `unknown`; a string (or null) here must fail rather than be used as a token.
  for (const result of ['ghs_raw_string', null, undefined, 42]) {
    await assert.rejects(
      () => getInstallationAccessToken(octokitReturning(result)),
      /Unable to resolve GitHub App installation token/,
      `${JSON.stringify(result)} must be rejected`
    )
  }
})

test('rejects an object with a missing, empty or non-string token', async () => {
  for (const result of [{}, { token: '' }, { token: '   ' }, { token: 7 }]) {
    await assert.rejects(
      () => getInstallationAccessToken(octokitReturning(result)),
      /Unable to resolve GitHub App installation token/,
      `${JSON.stringify(result)} must be rejected`
    )
  }
})
