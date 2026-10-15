import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import type { GitHubAppOctokit } from '../../src/github/octokit.js'
import type { IssueContext } from '../../src/github/issue-service.js'
import type { PullRequestContext } from '../../src/github/pull-request-service.js'

// The setup declaration is read for private repositories too. The read goes
// through the same installation-authenticated octokit the preparer already
// holds (the Contents API), *not* an unauthenticated client and not a separate
// git credential. These tests assert the preparers pass that octokit through
// and request the declaration at the exact default-branch SHA, so a private
// repository's declaration is read with the App's auth and a mismatched SHA
// would be caught.
//
// (Earlier this read was a second `git fetch` with a separately minted
// installation token; the issue and repository preparers once omitted the token
// and broke every private run. Reading through the shared octokit removes that
// class of bug, so this is the guard for the current shape.)

const execFileAsync = promisify(execFile)

const DECLARATION = 'setup:\n  - run: echo hi\n'

interface GitFixture {
  head_sha: string
}

async function createGitFixture(root: string): Promise<GitFixture> {
  const remote = path.join(root, 'octo', 'demo.git')
  const source = path.join(root, 'source')
  await fs.mkdir(path.dirname(remote), { recursive: true })
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['init', source])
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: source })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source })
  await fs.mkdir(path.join(source, 'src'), { recursive: true })
  await fs.writeFile(path.join(source, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')
  await execFileAsync('git', ['add', '.'], { cwd: source })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: source })
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: source })
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: source })
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: source })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
  return { head_sha: stdout.trim() }
}

interface OctokitRecording {
  octokit: GitHubAppOctokit
  contentRequests: Array<{ owner?: string; repo?: string; path: string; ref?: string }>
}

/** An octokit whose Contents API serves `files` and records each request. */
function octokitWithSetupDeclaration(
  sha: string,
  files: Record<string, string> = { '.sec-review/setup.yml': DECLARATION }
): OctokitRecording {
  const contentRequests: Array<{ owner?: string; repo?: string; path: string; ref?: string }> = []
  const octokit = {
    auth: async () => ({ token: 'test-installation-token' }),
    request: async () => ({ data: '' }),
    graphql: async () => ({
      repository: {
        pullRequest: {
          commits: {
            pageInfo: { hasNextPage: false },
            nodes: [{ commit: { oid: sha } }]
          }
        }
      }
    }),
    rest: {
      repos: {
        get: async () => ({
          data: { full_name: 'octo/demo', default_branch: 'main', html_url: '', private: true }
        }),
        getBranch: async () => ({ data: { commit: { sha } } }),
        getCommit: async ({ ref }: { ref: string }) => ({ data: { sha: ref } }),
        getContent: async ({
          owner,
          repo,
          path,
          ref
        }: {
          owner?: string
          repo?: string
          path: string
          ref?: string
        }) => {
          contentRequests.push({
            ...(owner !== undefined ? { owner } : {}),
            ...(repo !== undefined ? { repo } : {}),
            path,
            ...(ref !== undefined ? { ref } : {})
          })
          const content = files[path]
          if (content === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 })
          }
          return { data: { content: Buffer.from(content, 'utf8').toString('base64') } }
        },
        compareCommitsWithBasehead: async () => ({
          data: { status: 'ahead', files: [], commits: [] }
        }),
        listCommits: async () => ({ data: [] }),
        listContributors: async () => ({ data: [] })
      },
      issues: { listEventsForTimeline: async () => ({ data: [] }) },
      pulls: { listFiles: async () => ({ data: [] }) }
    }
  } as unknown as GitHubAppOctokit
  return { octokit, contentRequests }
}

function issueContext(default_branch = 'main'): IssueContext {
  return {
    action: 'opened',
    repo_name: 'demo',
    repo_full_name: 'octo/demo',
    owner_login: 'octo',
    sender_login: 'alice',
    default_branch,
    issue_number: 42,
    issue_title: 'demo issue',
    issue_body: 'body',
    issue_author: 'alice',
    issue_state: 'open',
    labels: [],
    html_url: 'https://github.com/octo/demo/issues/42',
    api_url: 'https://api.github.com/repos/octo/demo/issues/42',
    comments_url: 'https://api.github.com/repos/octo/demo/issues/42/comments',
    is_pull_request: false
  }
}

test(
  'issue prepare-input reads the setup declaration through the authenticated octokit',
  { concurrency: false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-auth-issue-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    const previousBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
    process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = path.join(root, 'bundles')
    try {
      const { head_sha } = await createGitFixture(root)
      process.env['GITHUB_SERVER_URL'] = `file://${root}`
      const { octokit, contentRequests } = octokitWithSetupDeclaration(head_sha)
      const { prepareIssueReviewInput } = await import('../../src/reviews/issues/prepare-input.js')
      const prepared = await prepareIssueReviewInput({
        run_id: 'run-issue-auth',
        octokit,
        issue: issueContext(),
        trusted_default_branch: { default_branch: 'main', head_sha }
      })
      assert.equal(prepared.input.setup_declaration, DECLARATION)
      // Read at the exact default-branch SHA, not a branch name.
      assert.deepEqual(contentRequests, [
        { owner: 'octo', repo: 'demo', path: '.sec-review/setup.yml', ref: head_sha }
      ])
    } finally {
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      if (previousBundleRoot === undefined) delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
      else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousBundleRoot
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)

test(
  'repository prepare-input reads the setup declaration through the authenticated octokit',
  { concurrency: false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-auth-repo-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    const previousBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
    process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = path.join(root, 'bundles')
    try {
      const { head_sha } = await createGitFixture(root)
      process.env['GITHUB_SERVER_URL'] = `file://${root}`
      const { octokit, contentRequests } = octokitWithSetupDeclaration(head_sha)
      const { prepareRepositoryReviewInput } =
        await import('../../src/reviews/repositories/prepare-input.js')
      const prepared = await prepareRepositoryReviewInput({
        run_id: 'run-repo-auth',
        octokit,
        repo_full_name: 'octo/demo',
        trusted_default_branch: { default_branch: 'main', head_sha },
        scan_mode: 'full'
      })
      assert.equal(prepared.input.setup_declaration, DECLARATION)
      assert.deepEqual(contentRequests, [
        { owner: 'octo', repo: 'demo', path: '.sec-review/setup.yml', ref: head_sha }
      ])
    } finally {
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      if (previousBundleRoot === undefined) delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
      else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousBundleRoot
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)

test(
  'PR prepare-input reads the declaration from the base-repo identity, not the payload repository',
  { concurrency: false },
  async () => {
    // The default-branch SHA is resolved from the base repo
    // (`resolveTrustedRepositoryIdentity`). The declaration read must use the
    // *same* identity: reading from a different repository would 404 and
    // silently degrade to "no declaration". Here the payload `repository` names
    // a decoy while `base_repo_full_name` (the trusted identity) is the repo the
    // SHA belongs to.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-auth-pr-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    const previousBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
    process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = path.join(root, 'bundles')
    try {
      const { head_sha } = await createGitFixture(root)
      process.env['GITHUB_SERVER_URL'] = `file://${root}`
      const { octokit, contentRequests } = octokitWithSetupDeclaration(head_sha)
      const pr: PullRequestContext = {
        action: 'opened',
        previous_head_sha: null,
        repo_name: 'demo',
        repo_full_name: 'octo/demo',
        owner_login: 'octo',
        sender_login: 'alice',
        pr_number: 7,
        pr_title: 'Update app',
        pr_body: 'body',
        pr_author: 'alice',
        is_draft: false,
        base_ref: 'main',
        base_sha: head_sha,
        head_ref: 'feature',
        head_sha,
        commits: 1,
        changed_files: 1,
        additions: 1,
        deletions: 1,
        html_url: '',
        api_url: '',
        commits_url: '',
        review_comments_url: '',
        comments_url: '',
        issue_url: '',
        head_repo_full_name: 'octo/demo',
        // The trusted identity (base repo) differs from the payload's
        // `repository` (octo/demo). The declaration read must follow the base
        // repo, the same identity the default-branch SHA was resolved from.
        base_repo_full_name: 'mirror/demo',
        from_fork: false
      }
      const { preparePullRequestReviewInput } =
        await import('../../src/reviews/pull-requests/prepare-input.js')
      const prepared = await preparePullRequestReviewInput({
        run_id: 'run-pr-auth',
        octokit,
        pr,
        trusted_default_branch: { default_branch: 'main', head_sha },
        files: []
      })
      assert.equal(prepared.input.setup_declaration, DECLARATION)
      assert.deepEqual(contentRequests, [
        { owner: 'mirror', repo: 'demo', path: '.sec-review/setup.yml', ref: head_sha }
      ])
    } finally {
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      if (previousBundleRoot === undefined) delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
      else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousBundleRoot
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)
