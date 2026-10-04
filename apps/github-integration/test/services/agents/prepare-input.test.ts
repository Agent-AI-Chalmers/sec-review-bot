import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { promisify } from 'node:util'

import type { GitHubAppOctokit } from '../../../infrastructure/github/octokit.js'
import type { IssueContext } from '../../../infrastructure/github/issue-service.js'
import type { PullRequestContext } from '../../../infrastructure/github/pull-request-service.js'
import { WORKSPACE_SNAPSHOT_TAR_NAME } from '../../../infrastructure/runner/git-workspace.js'

const execFileAsync = promisify(execFile)
const PRIVATE_RUNNER_INPUT_KEYS = new Set([
  'runArtifactsPath',
  'analyzer_artifacts_path',
  'cvss_artifacts_path',
  'mitigator_artifacts_path',
  'verifier_artifacts_path',
  'single_agent_artifacts_path',
  'manifest_artifacts_path',
  'discovery_artifacts_path',
  'triage_artifacts_path',
  'cases_artifacts_path'
])

let suiteTempRoot: string
let suiteInputBundleRoot: string
const previousInputBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']

test.before(async () => {
  suiteTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-input-suite-'))
  suiteInputBundleRoot = path.join(suiteTempRoot, 'input-bundles')
  process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = suiteInputBundleRoot
})

test.after(async () => {
  if (previousInputBundleRoot === undefined) delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
  else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousInputBundleRoot
  await fs.rm(suiteTempRoot, { recursive: true, force: true })
})

async function createGitFixture (root: string): Promise<{ base_sha: string, head_sha: string }> {
  const remote = path.join(root, 'octo', 'demo.git')
  const source = path.join(root, 'source')
  await fs.mkdir(path.dirname(remote), { recursive: true })
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['init', source])
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: source })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source })
  await fs.mkdir(path.join(source, 'src'), { recursive: true })
  await fs.writeFile(path.join(source, 'src', 'app.ts'), 'export const value = 1\n')
  await execFileAsync('git', ['add', '.'], { cwd: source })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: source })
  const { stdout: base } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
  await fs.writeFile(path.join(source, 'src', 'app.ts'), 'export const value = 2\n')
  await execFileAsync('git', ['commit', '-am', 'head'], { cwd: source })
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source })
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: source })
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: source })
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: source })
  return { base_sha: base.trim(), head_sha: head.trim() }
}

function collectKeys (value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key)
      collectKeys(item, keys)
    }
  }
  return keys
}

function assertPathIsWithin (parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate)
  assert.notEqual(relative, '')
  assert.notEqual(relative, '..')
  assert.equal(path.isAbsolute(relative), false)
  assert.equal(relative.startsWith(`..${path.sep}`), false)
}

async function assertRunnerInputArtifact ({
  input,
  inputBundleRoot,
  inputPath,
  runId
}: {
  input: Record<string, unknown>
  inputBundleRoot: string
  inputPath: string
  runId: string
}): Promise<void> {
  assert.equal(input['input_bundle_uri'], inputBundleRoot)
  assert.match(inputBundleRoot, new RegExp(`${runId}$`))
  assertPathIsWithin(suiteInputBundleRoot, inputBundleRoot)
  assertPathIsWithin(inputBundleRoot, inputPath)
  const keys = collectKeys(input)
  for (const key of PRIVATE_RUNNER_INPUT_KEYS) {
    assert.equal(keys.has(key), false, `runner input must not expose ${key}`)
  }
  assert.deepEqual(JSON.parse(await fs.readFile(inputPath, 'utf8')), input)
}

function repositoryOctokit (refs: { base_sha: string, head_sha: string }): GitHubAppOctokit {
  return {
    auth: async () => ({ token: 'test-token' }),
    request: async () => ({ data: 'diff --git a/src/app.ts b/src/app.ts\n' }),
    rest: {
      repos: {
        get: async () => ({ data: { full_name: 'octo/demo', default_branch: 'main', html_url: '', private: false } }),
        getBranch: async ({ branch }: { branch: string }) => ({ data: { commit: { sha: branch === 'main' ? refs.head_sha : branch } } }),
        getCommit: async ({ ref }: { ref: string }) => ({ data: { sha: ref } }),
        compareCommitsWithBasehead: async () => ({
          data: {
            status: 'ahead',
            files: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 }],
            commits: [{ sha: refs.head_sha, commit: { message: 'head', author: { name: 'Test User', date: '2026-09-29T00:00:00Z' } }, author: { login: 'tester' } }]
          }
        })
      }
    }
  } as unknown as GitHubAppOctokit
}

test('issue input preparer keeps materialized git workspace files in snapshot', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'issue-input-workspace-'))
  const previousGitHubServerUrl = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
  try {
    const { prepareIssueReviewInput } = await import('../../../reviews/issues/prepare-input.js')
    const gitServerRoot = path.join(tempRoot, 'octo')
    const remoteRepoPath = path.join(gitServerRoot, 'demo.git')
    const source_repo_path = path.join(tempRoot, 'source-repo')
    await fs.mkdir(gitServerRoot, { recursive: true })
    await execFileAsync('git', ['init', '--bare', remoteRepoPath])
    await execFileAsync('git', ['init', source_repo_path])
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: source_repo_path })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source_repo_path })
    await fs.mkdir(path.join(source_repo_path, 'src'), { recursive: true })
    await fs.writeFile(path.join(source_repo_path, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')
    await execFileAsync('git', ['add', '.'], { cwd: source_repo_path })
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: source_repo_path })
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: source_repo_path })
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRepoPath], { cwd: source_repo_path })
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: source_repo_path })
    const { stdout: head_sha_stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source_repo_path })
    const head_sha = head_sha_stdout.trim()

    const octokit = {
      auth: async () => ({
        token: 'test-installation-token'
      }),
      rest: {
        repos: {
          getBranch: async () => ({
            data: {
              commit: {
                sha: head_sha
              }
            }
          })
        },
        issues: {
          listEventsForTimeline: async () => ({
            data: []
          })
        }
      }
    } as unknown as GitHubAppOctokit

    const issue: IssueContext = {
      action: 'opened',
      repo_name: 'demo',
      repo_full_name: 'octo/demo',
      owner_login: 'octo',
      sender_login: 'alice',
      default_branch: 'main',
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

    const prepared = await prepareIssueReviewInput({
      octokit,
      issue
    })
    assert.equal(prepared.input.contract_version, 'v4')
    assert.deepEqual(prepared.input.review_intent, { objective: 'audit' })
    assert.equal(prepared.input.issue.repo_full_name, 'octo/demo')
    await assertRunnerInputArtifact({
      input: prepared.input as unknown as Record<string, unknown>,
      inputBundleRoot: prepared.input_bundle_root,
      inputPath: prepared.input_path,
      runId: prepared.run_id
    })
    const manifest = JSON.parse(
      await fs.readFile(path.join(prepared.input_bundle_root, 'manifest.json'), 'utf8')
    ) as Record<string, unknown>
    assert.deepEqual(manifest, {
      contract_version: 'v4',
      kind: 'runner-input-bundle',
      workspace: { snapshot: WORKSPACE_SNAPSHOT_TAR_NAME },
      history: { path: 'history' }
    })
    const extractedSnapshot = path.join(tempRoot, 'snapshot')
    await fs.mkdir(extractedSnapshot, { recursive: true })
    await execFileAsync('tar', [
      '-xf',
      path.join(prepared.input_bundle_root, WORKSPACE_SNAPSHOT_TAR_NAME),
      '-C',
      extractedSnapshot
    ])

    assert.equal(
      await fs.readFile(path.join(extractedSnapshot, 'workspace', 'src', 'app.ts'), 'utf8'),
      'export const value = 1\n'
    )
  } finally {
    if (previousGitHubServerUrl === undefined) {
      delete process.env['GITHUB_SERVER_URL']
    } else {
      process.env['GITHUB_SERVER_URL'] = previousGitHubServerUrl
    }
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('pull request input preparer writes a canonical runner bundle', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-input-'))
  const previousServer = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
  try {
    const refs = await createGitFixture(tempRoot)
    const { preparePullRequestReviewInput } = await import('../../../reviews/pull-requests/prepare-input.js')
    const pr: PullRequestContext = {
      action: 'opened', previous_head_sha: null, repo_name: 'demo', repo_full_name: 'octo/demo', owner_login: 'octo', sender_login: 'alice',
      pr_number: 7, pr_title: 'Update app', pr_body: 'body', pr_author: 'alice', is_draft: false,
      base_ref: 'main', base_sha: refs.base_sha, head_ref: 'main', head_sha: refs.head_sha,
      commits: 2, changed_files: 1, additions: 1, deletions: 1, html_url: '', api_url: '', commits_url: '', review_comments_url: '', comments_url: '', issue_url: '',
      head_repo_full_name: 'octo/demo', base_repo_full_name: 'octo/demo', from_fork: false
    }
    const octokit = {
      auth: async () => ({ token: 'test-token' }),
      graphql: async () => ({ repository: { pullRequest: { commits: { pageInfo: { hasNextPage: false }, nodes: [{ commit: { oid: refs.head_sha } }] } } } }),
      rest: { issues: { listEventsForTimeline: async () => ({ data: [] }) } }
    } as unknown as GitHubAppOctokit
    const prepared = await preparePullRequestReviewInput({
      run_id: 'run-pr-fixture', octokit, pr,
      files: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@' }]
    })
    await assertRunnerInputArtifact({
      input: prepared.input as unknown as Record<string, unknown>,
      inputBundleRoot: prepared.input_bundle_root,
      inputPath: prepared.input_path,
      runId: prepared.run_id
    })
    assert.equal(prepared.input.pr.repo_full_name, 'octo/demo')
    assert.equal('pullRequest' in prepared.input, false)
    assert.equal('repository' in prepared.input, false)
    const manifest = JSON.parse(await fs.readFile(path.join(prepared.input_bundle_root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    assert.equal('incremental_window' in manifest, true)
    assert.equal(await fs.readFile(path.join(prepared.input_bundle_root, 'incremental-window', 'changed-files.json'), 'utf8').then(Boolean), true)
  } finally {
    if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']; else process.env['GITHUB_SERVER_URL'] = previousServer
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('repository input preparer writes full and incremental runner bundles', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-input-'))
  const previousServer = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
  try {
    const refs = await createGitFixture(tempRoot)
    const { prepareRepositoryReviewInput } = await import('../../../reviews/repositories/prepare-input.js')
    const octokit = repositoryOctokit(refs)
    const full = await prepareRepositoryReviewInput({ run_id: 'run-repo-full', octokit, repo_full_name: 'octo/demo', scan_mode: 'full' })
    await assertRunnerInputArtifact({
      input: full.input as unknown as Record<string, unknown>,
      inputBundleRoot: full.input_bundle_root,
      inputPath: full.input_path,
      runId: full.run_id
    })
    assert.equal(full.input.scan_target.scan_mode, 'full')
    assert.equal('max_file_bytes' in full.input.scan_scope, false)
    assert.equal('repo_full_name' in full.input.scan_target, false)
    assert.equal('repository' in full.input, false)
    const fullManifest = JSON.parse(await fs.readFile(path.join(full.input_bundle_root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    assert.equal('incremental_window' in fullManifest, false)

    const incremental = await prepareRepositoryReviewInput({ run_id: 'run-repo-incremental', octokit, repo_full_name: 'octo/demo', scan_mode: 'incremental', base_sha: refs.base_sha, head_sha: refs.head_sha })
    await assertRunnerInputArtifact({
      input: incremental.input as unknown as Record<string, unknown>,
      inputBundleRoot: incremental.input_bundle_root,
      inputPath: incremental.input_path,
      runId: incremental.run_id
    })
    assert.equal(incremental.input.scan_target.scan_mode, 'incremental')
    assert.equal(incremental.input.scan_target.base_sha, refs.base_sha)
    assert.equal(incremental.input.scan_scope.incremental_changed_files[0]?.path, 'src/app.ts')
    const incrementalManifest = JSON.parse(await fs.readFile(path.join(incremental.input_bundle_root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    assert.equal('incremental_window' in incrementalManifest, true)
  } finally {
    if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']; else process.env['GITHUB_SERVER_URL'] = previousServer
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
