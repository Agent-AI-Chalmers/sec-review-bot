import { expect, test } from 'vitest'

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
  expect(normalizeRepositoryPermission('write')).toBe('write')
  expect(normalizeRepositoryPermission('owner')).toBe('unknown')
  expect(normalizeRepositoryPermission(undefined)).toBe('unknown')
})

test('manual comment authorization allows write permission', async () => {
  const decision = await authorizeManualCommentCommand({
    octokit: octokitWithPermission('write'),
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  expect(decision.allowed).toBe(true)
  expect(decision.permission).toBe('write')
  expect(decision.reason).toBe('allowed')
})

test('manual comment authorization allows maintain and admin permissions', async () => {
  for (const permission of ['maintain', 'admin']) {
    const decision = await authorizeManualCommentCommand({
      octokit: octokitWithPermission(permission),
      owner_login: 'octo',
      repo_name: 'example-repo',
      sender_login: 'alice'
    })

    expect(decision.allowed).toBe(true)
    expect(decision.permission).toBe(permission)
    expect(decision.reason).toBe('allowed')
  }
})

test('manual comment authorization denies triage permission', async () => {
  const decision = await authorizeManualCommentCommand({
    octokit: octokitWithPermission('triage'),
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  expect(decision.allowed).toBe(false)
  expect(decision.permission).toBe('triage')
  expect(decision.reason).toBe('insufficient-permission')
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

  expect(decision.allowed).toBe(false)
  expect(decision.permission).toBe('unknown')
  expect(decision.reason).toBe('missing-sender')
  expect(requests, 'no GitHub request may be made').toHaveLength(0)
})

test('manual comment authorization denies when permission lookup fails', async () => {
  // A real API failure is an HTTP error status, which Octokit maps to a RequestError.
  const octokit = fakeGitHub(() => githubJson({ message: 'unavailable' }, 500)).octokit

  const decision = await authorizeManualCommentCommand({
    octokit,
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  expect(decision.allowed).toBe(false)
  expect(decision.permission).toBe('unknown')
  expect(decision.reason).toBe('permission-lookup-failed')
})
