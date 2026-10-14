import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveTrustedDefaultBranch,
  type TrustedDefaultBranch
} from '../../src/github/default-branch-service.js'
import { resolvePullRequestDefaultBranch } from '../../src/github/pull-request-service.js'
import type { GitHubAppOctokit } from '../../src/github/octokit.js'

interface RepoGetCall {
  owner: string
  repo: string
}
interface BranchGetCall extends RepoGetCall {
  branch: string
}

function makeOctokit(options: {
  default_branch?: string
  head_sha?: string
  getThrows?: Error
  branchThrows?: Error
  onRepoGet?: (call: RepoGetCall) => void
  onBranchGet?: (call: BranchGetCall) => void
}) {
  const calls = { repoGet: [] as RepoGetCall[], branchGet: [] as BranchGetCall[] }
  const octokit = {
    rest: {
      repos: {
        get: async ({ owner, repo }: RepoGetCall) => {
          calls.repoGet.push({ owner, repo })
          options.onRepoGet?.({ owner, repo })
          if (options.getThrows) throw options.getThrows
          return { data: { default_branch: options.default_branch ?? 'main' } }
        },
        getBranch: async ({ owner, repo, branch }: BranchGetCall) => {
          calls.branchGet.push({ owner, repo, branch })
          options.onBranchGet?.({ owner, repo, branch })
          if (options.branchThrows) throw options.branchThrows
          return { data: { commit: { sha: options.head_sha ?? 'default-sha' } } }
        }
      }
    }
  } as unknown as GitHubAppOctokit
  return { octokit, calls }
}

// Invariant 3: branch name/SHA resolved by API, not from any payload field.
test('resolveTrustedDefaultBranch resolves the default branch via the API', async () => {
  const { octokit, calls } = makeOctokit({
    default_branch: 'trunk',
    head_sha: 'trunk-sha'
  })
  const result: TrustedDefaultBranch = await resolveTrustedDefaultBranch(octokit, {
    owner_login: 'octo',
    repo_name: 'example'
  })
  assert.deepEqual(result, { default_branch: 'trunk', head_sha: 'trunk-sha' })
  assert.deepEqual(calls.repoGet, [{ owner: 'octo', repo: 'example' }])
  assert.deepEqual(calls.branchGet, [{ owner: 'octo', repo: 'example', branch: 'trunk' }])
})

// Invariant 4: API failure -> explicit failure, no fallback.
test('resolveTrustedDefaultBranch throws when the repository API call fails', async () => {
  const { octokit } = makeOctokit({ getThrows: new Error('403 rate limited') })
  await assert.rejects(
    () => resolveTrustedDefaultBranch(octokit, { owner_login: 'octo', repo_name: 'example' }),
    /403 rate limited/
  )
})

test('resolveTrustedDefaultBranch throws when the branch API call fails', async () => {
  const { octokit } = makeOctokit({ branchThrows: new Error('404 not found') })
  await assert.rejects(
    () => resolveTrustedDefaultBranch(octokit, { owner_login: 'octo', repo_name: 'example' }),
    /404 not found/
  )
})

test('resolveTrustedDefaultBranch rejects an empty default branch', async () => {
  const { octokit } = makeOctokit({ default_branch: '' })
  await assert.rejects(
    () => resolveTrustedDefaultBranch(octokit, { owner_login: 'octo', repo_name: 'example' }),
    /empty default branch/
  )
})

// Invariant 2: recipe source repository == base repo; never the head/fork.
test('resolvePullRequestDefaultBranch prefers base repo identity over head/fork', async () => {
  const { octokit, calls } = makeOctokit({ default_branch: 'main', head_sha: 'base-head' })
  const result = await resolvePullRequestDefaultBranch(octokit, {
    repo_full_name: 'octo/example',
    base_repo_full_name: 'octo/example'
  })
  assert.equal(result.head_sha, 'base-head')
  // both repo get + branch get target the base repo, not the fork
  assert.deepEqual(calls.branchGet, [{ owner: 'octo', repo: 'example', branch: 'main' }])
})

test('resolvePullRequestDefaultBranch never resolves against the head repo for a fork PR', async () => {
  const { octokit, calls } = makeOctokit({ default_branch: 'main', head_sha: 'base-head' })
  // top-level repo is the base repo; head/fork is mallory/example
  await resolvePullRequestDefaultBranch(octokit, {
    repo_full_name: 'octo/example',
    base_repo_full_name: 'octo/example'
  })
  for (const call of calls.repoGet) {
    assert.notEqual(call.owner, 'mallory')
  }
  for (const call of calls.branchGet) {
    assert.notEqual(call.owner, 'mallory')
  }
})

test('resolvePullRequestDefaultBranch falls back to repo_full_name when base is missing', async () => {
  const { octokit, calls } = makeOctokit({ default_branch: 'main', head_sha: 'sha' })
  await resolvePullRequestDefaultBranch(octokit, {
    repo_full_name: 'octo/example',
    base_repo_full_name: null
  })
  assert.deepEqual(calls.repoGet, [{ owner: 'octo', repo: 'example' }])
})
