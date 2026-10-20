import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizeManualCommentCommand,
  normalizeRepositoryPermission
} from '../../src/github/manual-command-authorization.js'
import type { Octokit } from 'octokit'
import { fakeGitHub, githubJson, unusedGitHub } from '../github-client.js'

function octokitWithPermission(permission: string): Octokit {
  return fakeGitHub(() => githubJson({ permission })).octokit
}

test('normalizes unknown repository permissions conservatively', () => {
  assert.strictEqual(normalizeRepositoryPermission('write'), 'write')
  assert.strictEqual(normalizeRepositoryPermission('owner'), 'unknown')
  assert.strictEqual(normalizeRepositoryPermission(undefined), 'unknown')
})

test('manual comment authorization allows write permission', async () => {
  const decision = await authorizeManualCommentCommand({
    octokit: octokitWithPermission('write'),
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  assert.strictEqual(decision.allowed, true)
  assert.strictEqual(decision.permission, 'write')
  assert.strictEqual(decision.reason, 'allowed')
})

test('manual comment authorization allows maintain and admin permissions', async () => {
  for (const permission of ['maintain', 'admin']) {
    const decision = await authorizeManualCommentCommand({
      octokit: octokitWithPermission(permission),
      owner_login: 'octo',
      repo_name: 'example-repo',
      sender_login: 'alice'
    })

    assert.strictEqual(decision.allowed, true)
    assert.strictEqual(decision.permission, permission)
    assert.strictEqual(decision.reason, 'allowed')
  }
})

test('manual comment authorization denies triage permission', async () => {
  const decision = await authorizeManualCommentCommand({
    octokit: octokitWithPermission('triage'),
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  assert.strictEqual(decision.allowed, false)
  assert.strictEqual(decision.permission, 'triage')
  assert.strictEqual(decision.reason, 'insufficient-permission')
})

test('manual comment authorization denies missing sender without GitHub lookup', async () => {
  // `unusedGitHub` throws if the code under test reaches GitHub, so `lookupCalled` staying false
  // is proven by the request never arriving rather than by a stub being bypassed.
  const { octokit, requests } = unusedGitHub()

  const decision = await authorizeManualCommentCommand({
    octokit,
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: undefined
  })

  assert.strictEqual(decision.allowed, false)
  assert.strictEqual(decision.permission, 'unknown')
  assert.strictEqual(decision.reason, 'missing-sender')
  assert.strictEqual(requests.length, 0, 'no GitHub request may be made')
})

test('manual comment authorization denies when permission lookup fails', async () => {
  // A real API failure is an HTTP error status, which Octokit maps to a RequestError.
  const octokit = fakeGitHub(() =>
    githubJson({ message: 'unavailable' }, 500)
  ).octokit

  const decision = await authorizeManualCommentCommand({
    octokit,
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  assert.strictEqual(decision.allowed, false)
  assert.strictEqual(decision.permission, 'unknown')
  assert.strictEqual(decision.reason, 'permission-lookup-failed')
})
