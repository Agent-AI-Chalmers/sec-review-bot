import { expect, test } from 'vitest'

import {
  resolveTrustedDefaultBranch,
  type TrustedDefaultBranch
} from '../../src/github/default-branch-service.js'
import { resolveTrustedRepositoryIdentity } from '../../src/github/pull-request-service.js'
import { fakeGitHub, githubFile, githubJson } from '../github-client.js'

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
  /** An HTTP error status for the repository metadata call (a real API reply, so Octokit maps it
   * to a RequestError with that status instead of retrying a thrown network fault). */
  getStatus?: number
  branchStatus?: number
  onRepoGet?: (call: RepoGetCall) => void
  onBranchGet?: (call: BranchGetCall) => void
}) {
  const calls = {
    repoGet: [] as RepoGetCall[],
    branchGet: [] as BranchGetCall[]
  }
  const { octokit, requests } = fakeGitHub(({ url }) => {
    // GET /repos/{owner}/{repo}            -> repository metadata
    // GET /repos/{owner}/{repo}/branches/{branch} -> branch head
    // GET /repos/{owner}/{repo}/contents/{path}   -> the config file
    const match = /\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(new URL(url).pathname)
    const owner = match?.[1] ?? ''
    const repo = match?.[2] ?? ''
    const tail = match?.[3] ?? ''

    const branchMatch = /^\/branches\/(.+)$/.exec(tail)
    if (branchMatch) {
      const branch = decodeURIComponent(branchMatch[1] ?? '')
      calls.branchGet.push({ owner, repo, branch })
      options.onBranchGet?.({ owner, repo, branch })
      if (options.branchStatus !== undefined) {
        return githubJson({ message: 'not found' }, options.branchStatus)
      }
      return githubJson({
        commit: { sha: options.head_sha ?? 'default-sha' }
      })
    }

    if (tail.startsWith('/contents/')) {
      return githubFile('sec_review_bot:\n  trigger_mode: manual_only\n')
    }

    calls.repoGet.push({ owner, repo })
    options.onRepoGet?.({ owner, repo })
    if (options.getStatus !== undefined) {
      return githubJson({ message: 'forbidden' }, options.getStatus)
    }
    return githubJson({ default_branch: options.default_branch ?? 'main' })
  })
  return { octokit, calls, requests }
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
  expect(result).toStrictEqual({
    default_branch: 'trunk',
    head_sha: 'trunk-sha'
  })
  expect(calls.repoGet).toStrictEqual([{ owner: 'octo', repo: 'example' }])
  expect(calls.branchGet).toStrictEqual([{ owner: 'octo', repo: 'example', branch: 'trunk' }])
})

// Invariant 4: API failure -> explicit failure, no fallback.
test('resolveTrustedDefaultBranch throws when the repository API call fails', async () => {
  const { octokit } = makeOctokit({ getStatus: 403 })
  await expect(
    resolveTrustedDefaultBranch(octokit, {
      owner_login: 'octo',
      repo_name: 'example'
    })
  ).rejects.toSatisfy((e: { status?: number }) => e.status === 403)
})

test('resolveTrustedDefaultBranch throws when the branch API call fails', async () => {
  const { octokit } = makeOctokit({ branchStatus: 404 })
  await expect(
    resolveTrustedDefaultBranch(octokit, {
      owner_login: 'octo',
      repo_name: 'example'
    })
  ).rejects.toSatisfy((e: { status?: number }) => e.status === 404)
})

test('resolveTrustedDefaultBranch rejects an empty default branch', async () => {
  const { octokit } = makeOctokit({ default_branch: '' })
  await expect(
    resolveTrustedDefaultBranch(octokit, {
      owner_login: 'octo',
      repo_name: 'example'
    })
  ).rejects.toThrow(/empty default branch/)
})

// Invariant 2: recipe source repository == base repo; never the head/fork.
test('resolveTrustedRepositoryIdentity prefers base repo identity over head/fork', () => {
  expect(
    resolveTrustedRepositoryIdentity({
      repo_full_name: 'octo/example',
      base_repo_full_name: 'octo/example'
    })
  ).toStrictEqual({ owner_login: 'octo', repo_name: 'example' })
})

test('resolveTrustedRepositoryIdentity never uses the head repo for a fork PR', () => {
  // top-level repo is the base repo; head/fork is mallory/example
  const identity = resolveTrustedRepositoryIdentity({
    repo_full_name: 'octo/example',
    base_repo_full_name: 'octo/example'
  })
  expect(identity.owner_login).not.toBe('mallory')
})

test('resolveTrustedRepositoryIdentity falls back to repo_full_name when base is missing', () => {
  expect(
    resolveTrustedRepositoryIdentity({
      repo_full_name: 'octo/example',
      base_repo_full_name: null
    })
  ).toStrictEqual({ owner_login: 'octo', repo_name: 'example' })
})

// Wiring: a fork PR's trusted identity (base repo) drives which repository the
// config/declaration resolution actually hits.
test('fetchTrustedRepositoryTriggerConfig resolves against the base repo, not the fork', async () => {
  const { octokit, calls } = makeOctokit({
    default_branch: 'main',
    head_sha: 'base-sha'
  })
  const { fetchTrustedRepositoryTriggerConfig } =
    await import('../../src/github/repo-config-service.js')

  const identity = resolveTrustedRepositoryIdentity({
    repo_full_name: 'octo/example',
    base_repo_full_name: 'octo/example'
  })
  await fetchTrustedRepositoryTriggerConfig(octokit, identity).catch(() => undefined)

  for (const call of calls.repoGet) {
    expect(call.owner).toBe('octo')
    expect(call.repo).toBe('example')
    expect(call.owner).not.toBe('mallory')
  }
  expect.assert(calls.repoGet.length >= 1)
  expect.assert(calls.branchGet.length >= 1)
  for (const call of calls.branchGet) {
    expect(call.owner).toBe('octo')
    expect(call.owner).not.toBe('mallory')
  }
})
