import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizeManualCommentCommand,
  normalizeRepositoryPermission
} from '../../infrastructure/github/manual-command-authorization.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'

function octokitWithPermission (permission: string): GitHubAppOctokit {
  return {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission } })
      }
    }
  } as unknown as GitHubAppOctokit
}

test('normalizes unknown repository permissions conservatively', () => {
  assert.equal(normalizeRepositoryPermission('write'), 'write')
  assert.equal(normalizeRepositoryPermission('owner'), 'unknown')
  assert.equal(normalizeRepositoryPermission(undefined), 'unknown')
})

test('manual comment authorization allows write permission', async () => {
  const decision = await authorizeManualCommentCommand({
    octokit: octokitWithPermission('write'),
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  assert.equal(decision.allowed, true)
  assert.equal(decision.permission, 'write')
  assert.equal(decision.reason, 'allowed')
})

test('manual comment authorization allows maintain and admin permissions', async () => {
  for (const permission of ['maintain', 'admin']) {
    const decision = await authorizeManualCommentCommand({
      octokit: octokitWithPermission(permission),
      owner_login: 'octo',
      repo_name: 'example-repo',
      sender_login: 'alice'
    })

    assert.equal(decision.allowed, true)
    assert.equal(decision.permission, permission)
    assert.equal(decision.reason, 'allowed')
  }
})

test('manual comment authorization denies triage permission', async () => {
  const decision = await authorizeManualCommentCommand({
    octokit: octokitWithPermission('triage'),
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.permission, 'triage')
  assert.equal(decision.reason, 'insufficient-permission')
})

test('manual comment authorization denies missing sender without GitHub lookup', async () => {
  let lookupCalled = false
  const octokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          lookupCalled = true
          throw new Error('lookup should not be called')
        }
      }
    }
  } as unknown as GitHubAppOctokit

  const decision = await authorizeManualCommentCommand({
    octokit,
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: undefined
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.permission, 'unknown')
  assert.equal(decision.reason, 'missing-sender')
  assert.equal(lookupCalled, false)
})

test('manual comment authorization denies when permission lookup fails', async () => {
  const octokit = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          throw new Error('GitHub unavailable')
        }
      }
    }
  } as unknown as GitHubAppOctokit

  const decision = await authorizeManualCommentCommand({
    octokit,
    owner_login: 'octo',
    repo_name: 'example-repo',
    sender_login: 'alice'
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.permission, 'unknown')
  assert.equal(decision.reason, 'permission-lookup-failed')
})
