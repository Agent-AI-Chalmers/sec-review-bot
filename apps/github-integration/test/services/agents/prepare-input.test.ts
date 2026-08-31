import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { promisify } from 'node:util'

import type { GitHubAppOctokit } from '../../../infrastructure/github/octokit.js'
import type { IssueContext } from '../../../infrastructure/github/issue-service.js'
import { WORKSPACE_SNAPSHOT_TAR_NAME } from '../../../infrastructure/runner/git-workspace.js'

const PACKAGE_ROOT = process.cwd()
const execFileAsync = promisify(execFile)

const PREPARE_INPUT_PATHS = [
  'reviews/issues/prepare-input.ts',
  'reviews/pull-requests/prepare-input.ts',
  'reviews/repositories/prepare-input.ts'
] as const

const STAGE_ARTIFACT_PATH_KEYS = [
  'analyzer_artifacts_path',
  'cvss_artifacts_path',
  'mitigator_artifacts_path',
  'verifier_artifacts_path',
  'single_agent_artifacts_path',
  'manifest_artifacts_path',
  'discovery_artifacts_path',
  'triage_artifacts_path',
  'cases_artifacts_path'
] as const

const RUN_ARTIFACT_ROOT_KEY = 'runArtifacts' + 'Path'

async function readPackageSource (relativePath: string): Promise<string> {
  return fs.readFile(path.join(PACKAGE_ROOT, relativePath), 'utf8')
}

test('app input preparers do not send runner artifact roots to agents', async () => {
  for (const relativePath of PREPARE_INPUT_PATHS) {
    const source = await readPackageSource(relativePath)
    assert.equal(
      source.includes(RUN_ARTIFACT_ROOT_KEY),
      false,
      `${relativePath} must not materialize runner artifact root`
    )
    for (const key of STAGE_ARTIFACT_PATH_KEYS) {
      assert.equal(
        source.includes(key),
        false,
        `${relativePath} must not materialize agents stage artifact field ${key}`
      )
    }
  }
})

test('app input preparers isolate input bundle root by run id', async () => {
  const sharedSource = await readPackageSource('reviews/shared/input-bundle.ts')
  assert.match(
    sharedSource,
    /export function createInputBundleRoot[\s\S]*path\.resolve\([\s\S]*input_bundle_staging_root[\s\S]*segments\.map\(sanitizePathSegment\)[\s\S]*\)/,
    'shared input bundle helper must resolve bundle roots under the staging root'
  )

  for (const relativePath of PREPARE_INPUT_PATHS) {
    const source = await readPackageSource(relativePath)
    assert.match(
      source,
      /const run_id = createRunId\(\)[\s\S]*const input_bundle_root = createInputBundleRoot\([\s\S]*run_id[\s\S]*\)/,
      `${relativePath} must include run_id when constructing the input bundle root`
    )
  }
})

test('pull request input preparer emits canonical pr input before runner dispatch', async () => {
  const source = await readPackageSource('reviews/pull-requests/prepare-input.ts')

  assert.match(source, /pr:\s*pullRequestMetadata/)
  assert.doesNotMatch(source, /pullRequest:\s*pullRequestMetadata/)
  assert.doesNotMatch(source, /repository:\s*{\s*fullName:\s*pr\.repo_full_name\s*}/)
})

test('repository input preparer keeps repository identity out of runner input', async () => {
  const source = await readPackageSource('reviews/repositories/prepare-input.ts')

  assert.doesNotMatch(source, /repository:\s*{\s*fullName:\s*repo\.repo_full_name\s*}/)
  assert.doesNotMatch(source, /scan_target:\s*{[^}]*repo_full_name/s)
})

test('issue input preparer keeps materialized git workspace files in snapshot', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'issue-input-workspace-'))
  const previousInputBundleRoot = process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
  const previousGitHubServerUrl = process.env['GITHUB_SERVER_URL']
  process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = path.join(tempRoot, 'input-bundles')
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
    if (previousInputBundleRoot === undefined) {
      delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
    } else {
      process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousInputBundleRoot
    }
    if (previousGitHubServerUrl === undefined) {
      delete process.env['GITHUB_SERVER_URL']
    } else {
      process.env['GITHUB_SERVER_URL'] = previousGitHubServerUrl
    }
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
