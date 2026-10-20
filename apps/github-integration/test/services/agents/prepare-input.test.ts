import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import type { Octokit } from 'octokit'
import type { IssueContext } from '../../../src/github/issue-service.js'
import type { PullRequestContext } from '../../../src/github/pull-request-service.js'
import { WORKSPACE_SNAPSHOT_TAR_NAME } from '../../../src/artifacts/git-workspace.js'
import { CONTRACT_VERSION } from '../../../src/runner/contract-version.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

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
  suiteTempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'prepare-input-suite-')
  )
  suiteInputBundleRoot = path.join(suiteTempRoot, 'input-bundles')
  process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = suiteInputBundleRoot
})

test.after(async () => {
  if (previousInputBundleRoot === undefined)
    delete process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT']
  else process.env['SEC_REVIEW_INPUT_BUNDLE_ROOT'] = previousInputBundleRoot
  await fs.rm(suiteTempRoot, { recursive: true, force: true })
})

async function createGitFixture(
  root: string
): Promise<{ base_sha: string; head_sha: string }> {
  const remote = path.join(root, 'octo', 'demo.git')
  const source = path.join(root, 'source')
  await fs.mkdir(path.dirname(remote), { recursive: true })
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['init', source])
  await execFileAsync('git', ['config', 'user.name', 'Test User'], {
    cwd: source
  })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: source
  })
  await fs.mkdir(path.join(source, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(source, 'src', 'app.ts'),
    'export const value = 1\n'
  )
  await execFileAsync('git', ['add', '.'], { cwd: source })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: source })
  const { stdout: base } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: source
  })
  await fs.writeFile(
    path.join(source, 'src', 'app.ts'),
    'export const value = 2\n'
  )
  await execFileAsync('git', ['commit', '-am', 'head'], { cwd: source })
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: source
  })
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: source })
  await execFileAsync('git', ['remote', 'add', 'origin', remote], {
    cwd: source
  })
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: source })
  return { base_sha: base.trim(), head_sha: head.trim() }
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
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

function assertPathIsWithin(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate)
  assert.notStrictEqual(relative, '')
  assert.notStrictEqual(relative, '..')
  assert.strictEqual(path.isAbsolute(relative), false)
  assert.strictEqual(relative.startsWith(`..${path.sep}`), false)
}

/** Assert the archive behind a prepared input.
 *
 * Generic over the input type so a caller can pass its concrete `*ReviewInput` without widening it
 * to `Record<string, unknown>` first; only `input_bundle` is read here.
 */
async function assertRunnerInputArtifact<
  T extends { input_bundle: { media_type: string; uri: string } }
>({
  input,
  inputBundleRoot,
  inputPath,
  runId
}: {
  input: T
  inputBundleRoot: string
  inputPath: string
  runId: string
}): Promise<void> {
  const inputBundle = input['input_bundle'] as Record<string, unknown>
  assert.strictEqual(inputBundle['media_type'], 'application/tar+zstd')
  const archivePath = fileURLToPath(String(inputBundle['uri']))
  assert.strictEqual(archivePath, `${inputBundleRoot}.tar.zst`)
  const archive = await fs.readFile(archivePath)
  assert.strictEqual(inputBundle['size_bytes'], archive.byteLength)
  assert.strictEqual(
    inputBundle['digest'],
    `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`
  )
  const { stdout: archiveListing } = await execFileAsync('tar', [
    '--zstd',
    '-tf',
    archivePath
  ])
  assert.match(archiveListing, /^manifest\.json$/m)
  assert.match(
    archiveListing,
    new RegExp(`^${WORKSPACE_SNAPSHOT_TAR_NAME}$`, 'm')
  )
  assert.doesNotMatch(archiveListing, /^workspace\//m)
  assert.doesNotMatch(archiveListing, /review-input\.json$/m)
  assert.match(inputBundleRoot, new RegExp(`${runId}$`))
  assertPathIsWithin(suiteInputBundleRoot, inputBundleRoot)
  assertPathIsWithin(inputBundleRoot, inputPath)
  const keys = collectKeys(input)
  for (const key of PRIVATE_RUNNER_INPUT_KEYS) {
    assert.strictEqual(
      keys.has(key),
      false,
      `runner input must not expose ${key}`
    )
  }
  assert.deepStrictEqual(
    JSON.parse(await fs.readFile(inputPath, 'utf8')),
    input
  )
}

function repositoryOctokit(refs: {
  base_sha: string
  head_sha: string
}): Octokit {
  return fakeGitHub(({ url }) => {
    const parsed = new URL(url)
    const pathname = parsed.pathname
    if (pathname.includes('/compare/')) {
      return githubJson({
        status: 'ahead',
        files: [
          {
            filename: 'src/app.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2
          }
        ],
        commits: [
          {
            sha: refs.head_sha,
            commit: {
              message: 'head',
              author: { name: 'Test User', date: '2026-09-29T00:00:00Z' }
            },
            author: { login: 'tester' }
          }
        ]
      })
    }
    if (pathname.includes('/branches/')) {
      const branch = decodeURIComponent(pathname.split('/branches/')[1] ?? '')
      return githubJson({
        commit: { sha: branch === 'main' ? refs.head_sha : branch }
      })
    }
    if (pathname.includes('/commits/')) {
      const ref = decodeURIComponent(pathname.split('/commits/')[1] ?? '')
      return githubJson({ sha: ref })
    }
    if (pathname.includes('/contents/')) {
      return githubJson({ message: 'Not Found' }, 404)
    }
    return githubJson({
      full_name: 'octo/demo',
      default_branch: 'main',
      html_url: '',
      private: false
    })
  }).octokit
}

test(
  'issue input preparer keeps materialized git workspace files in snapshot',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'issue-input-workspace-')
    )
    const previousGitHubServerUrl = process.env['GITHUB_SERVER_URL']
    process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
    try {
      const { prepareIssueReviewInput } =
        await import('../../../src/reviews/issues/prepare-input.js')
      const gitServerRoot = path.join(tempRoot, 'octo')
      const remoteRepoPath = path.join(gitServerRoot, 'demo.git')
      const source_repo_path = path.join(tempRoot, 'source-repo')
      await fs.mkdir(gitServerRoot, { recursive: true })
      await execFileAsync('git', ['init', '--bare', remoteRepoPath])
      await execFileAsync('git', ['init', source_repo_path])
      await execFileAsync('git', ['config', 'user.name', 'Test User'], {
        cwd: source_repo_path
      })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: source_repo_path
      })
      await fs.mkdir(path.join(source_repo_path, 'src'), { recursive: true })
      await fs.writeFile(
        path.join(source_repo_path, 'src', 'app.ts'),
        'export const value = 1\n',
        'utf8'
      )
      await execFileAsync('git', ['add', '.'], { cwd: source_repo_path })
      await execFileAsync('git', ['commit', '-m', 'initial commit'], {
        cwd: source_repo_path
      })
      await execFileAsync('git', ['branch', '-M', 'main'], {
        cwd: source_repo_path
      })
      await execFileAsync('git', ['remote', 'add', 'origin', remoteRepoPath], {
        cwd: source_repo_path
      })
      await execFileAsync('git', ['push', 'origin', 'main'], {
        cwd: source_repo_path
      })
      const { stdout: head_sha_stdout } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        {
          cwd: source_repo_path
        }
      )
      const head_sha = head_sha_stdout.trim()

      const octokit = fakeGitHub(({ url }) => {
        const pathname = new URL(url).pathname
        if (pathname.includes('/contents/'))
          return githubJson({ message: 'Not Found' }, 404)
        if (pathname.includes('/branches/'))
          return githubJson({ commit: { sha: head_sha } })
        if (pathname.includes('/timeline')) return githubJson([])
        return githubJson({ default_branch: 'main' })
      }).octokit

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
        comments_url:
          'https://api.github.com/repos/octo/demo/issues/42/comments',
        is_pull_request: false
      }

      const prepared = await prepareIssueReviewInput({
        run_id: 'run-issue-fixture',
        octokit,
        issue,
        trusted_default_branch: { default_branch: 'main', head_sha }
      })
      assert.strictEqual(prepared.input.contract_version, 'v6')
      assert.deepStrictEqual(prepared.input.review_intent, {
        objective: 'audit'
      })
      assert.strictEqual(prepared.input.issue.repo_full_name, 'octo/demo')
      await assertRunnerInputArtifact({
        input: prepared.input,
        inputBundleRoot: prepared.input_bundle_root,
        inputPath: prepared.input_path,
        runId: prepared.run_id
      })
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(prepared.input_bundle_root, 'manifest.json'),
          'utf8'
        )
      ) as Record<string, unknown>
      assert.deepStrictEqual(manifest, {
        contract_version: CONTRACT_VERSION,
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

      assert.strictEqual(
        await fs.readFile(
          path.join(extractedSnapshot, 'workspace', 'src', 'app.ts'),
          'utf8'
        ),
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
  }
)

test(
  'pull request input preparer writes a canonical runner bundle',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-input-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
    try {
      const refs = await createGitFixture(tempRoot)
      const { preparePullRequestReviewInput } =
        await import('../../../src/reviews/pull-requests/prepare-input.js')
      const { fullReviewWindow } =
        await import('../../../src/reviews/pull-requests/review-window.js')
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
        base_sha: refs.base_sha,
        head_ref: 'main',
        head_sha: refs.head_sha,
        commits: 2,
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
        base_repo_full_name: 'octo/demo',
        from_fork: false
      }
      const octokit = fakeGitHub(({ url }) => {
        const pathname = new URL(url).pathname
        if (pathname === '/graphql') {
          return githubJson({
            data: {
              repository: {
                pullRequest: {
                  commits: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ commit: { oid: refs.head_sha } }]
                  }
                }
              }
            }
          })
        }
        if (pathname.includes('/contents/'))
          return githubJson({ message: 'Not Found' }, 404)
        if (pathname.includes('/branches/'))
          return githubJson({ commit: { sha: refs.head_sha } })
        if (pathname.includes('/timeline')) return githubJson([])
        return githubJson({ default_branch: 'main' })
      }).octokit
      const prepared = await preparePullRequestReviewInput({
        run_id: 'run-pr-fixture',
        octokit,
        pr,
        window: fullReviewWindow({
          base_sha: pr.base_sha,
          head_sha: pr.head_sha
        }),
        trusted_default_branch: {
          default_branch: 'main',
          head_sha: refs.head_sha
        },
        files: [
          {
            filename: 'src/app.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@'
          }
        ]
      })
      await assertRunnerInputArtifact({
        input: prepared.input,
        inputBundleRoot: prepared.input_bundle_root,
        inputPath: prepared.input_path,
        runId: prepared.run_id
      })
      assert.strictEqual(prepared.input.pr.repo_full_name, 'octo/demo')
      assert.strictEqual('pullRequest' in prepared.input, false)
      assert.strictEqual('repository' in prepared.input, false)
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(prepared.input_bundle_root, 'manifest.json'),
          'utf8'
        )
      ) as Record<string, unknown>
      assert.strictEqual('incremental_window' in manifest, true)
      assert.strictEqual(
        await fs
          .readFile(
            path.join(
              prepared.input_bundle_root,
              'incremental-window',
              'changed-files.json'
            ),
            'utf8'
          )
          .then(Boolean),
        true
      )
    } finally {
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }
)

test(
  'repository input preparer writes full and incremental runner bundles',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-input-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
    try {
      const refs = await createGitFixture(tempRoot)
      const { prepareRepositoryReviewInput } =
        await import('../../../src/reviews/repositories/prepare-input.js')
      const octokit = repositoryOctokit(refs)
      const full = await prepareRepositoryReviewInput({
        run_id: 'run-repo-full',
        octokit,
        repo_full_name: 'octo/demo',
        trusted_default_branch: {
          default_branch: 'main',
          head_sha: refs.head_sha
        },
        scan_mode: 'full'
      })
      await assertRunnerInputArtifact({
        input: full.input,
        inputBundleRoot: full.input_bundle_root,
        inputPath: full.input_path,
        runId: full.run_id
      })
      assert.strictEqual(full.input.scan_target.scan_mode, 'full')
      assert.strictEqual('max_file_bytes' in full.input.scan_scope, false)
      assert.strictEqual('repo_full_name' in full.input.scan_target, false)
      assert.strictEqual('repository' in full.input, false)
      const fullManifest = JSON.parse(
        await fs.readFile(
          path.join(full.input_bundle_root, 'manifest.json'),
          'utf8'
        )
      ) as Record<string, unknown>
      assert.strictEqual('incremental_window' in fullManifest, false)

      await fs.writeFile(
        path.join(full.input_bundle_root, 'stale-from-failed-attempt.txt'),
        'stale'
      )
      const retriedFull = await prepareRepositoryReviewInput({
        run_id: 'run-repo-full',
        octokit,
        repo_full_name: 'octo/demo',
        trusted_default_branch: {
          default_branch: 'main',
          head_sha: refs.head_sha
        },
        scan_mode: 'full'
      })
      await assert.rejects(
        fs.access(
          path.join(
            retriedFull.input_bundle_root,
            'stale-from-failed-attempt.txt'
          )
        ),
        { code: 'ENOENT' }
      )

      const incremental = await prepareRepositoryReviewInput({
        run_id: 'run-repo-incremental',
        octokit,
        repo_full_name: 'octo/demo',
        trusted_default_branch: {
          default_branch: 'main',
          head_sha: refs.head_sha
        },
        scan_mode: 'incremental',
        base_sha: refs.base_sha,
        head_sha: refs.head_sha
      })
      await assertRunnerInputArtifact({
        input: incremental.input,
        inputBundleRoot: incremental.input_bundle_root,
        inputPath: incremental.input_path,
        runId: incremental.run_id
      })
      assert.strictEqual(incremental.input.scan_target.scan_mode, 'incremental')
      assert.strictEqual(incremental.input.scan_target.base_sha, refs.base_sha)
      assert.strictEqual(
        incremental.input.scan_scope.incremental_changed_files[0]?.path,
        'src/app.ts'
      )
      const incrementalManifest = JSON.parse(
        await fs.readFile(
          path.join(incremental.input_bundle_root, 'manifest.json'),
          'utf8'
        )
      ) as Record<string, unknown>
      assert.strictEqual('incremental_window' in incrementalManifest, true)
    } finally {
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }
)

test(
  'a push window keeps the patch and changed files on the same range',
  { concurrency: false },
  async () => {
    // The regression this prevents: `changed-files.json` describing only the
    // pushed commits while `incremental.patch` covered the whole pull request.
    // The analyzer is told to derive causality from both, so a mismatch makes it
    // suppress real changes or produce findings that cannot be anchored. Here the
    // window is deliberately narrowed to the last commit, and the patch must
    // shrink with it.
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-push-'))
    const previousServer = process.env['GITHUB_SERVER_URL']
    process.env['GITHUB_SERVER_URL'] = `file://${tempRoot}`
    try {
      const refs = await createGitFixture(tempRoot)
      const { preparePullRequestReviewInput } =
        await import('../../../src/reviews/pull-requests/prepare-input.js')
      const { pushReviewWindow } =
        await import('../../../src/reviews/pull-requests/review-window.js')
      const pr: PullRequestContext = {
        action: 'synchronize',
        previous_head_sha: refs.base_sha,
        repo_name: 'demo',
        repo_full_name: 'octo/demo',
        owner_login: 'octo',
        sender_login: 'alice',
        pr_number: 8,
        pr_title: 'Push one commit',
        pr_body: 'body',
        pr_author: 'alice',
        is_draft: false,
        base_ref: 'main',
        base_sha: refs.base_sha,
        head_ref: 'main',
        head_sha: refs.head_sha,
        commits: 2,
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
        base_repo_full_name: 'octo/demo',
        from_fork: false
      }
      const octokit = fakeGitHub(({ url }) => {
        const pathname = new URL(url).pathname
        if (pathname === '/graphql') {
          return githubJson({
            data: {
              repository: {
                pullRequest: {
                  commits: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ commit: { oid: refs.head_sha } }]
                  }
                }
              }
            }
          })
        }
        if (pathname.includes('/contents/'))
          return githubJson({ message: 'Not Found' }, 404)
        if (pathname.includes('/branches/'))
          return githubJson({ commit: { sha: refs.head_sha } })
        if (pathname.includes('/timeline')) return githubJson([])
        return githubJson({ default_branch: 'main' })
      }).octokit

      const window = pushReviewWindow({
        previous_head_sha: refs.base_sha,
        head_sha: refs.head_sha
      })
      const prepared = await preparePullRequestReviewInput({
        run_id: 'run-pr-push',
        octokit,
        pr,
        window,
        trusted_default_branch: {
          default_branch: 'main',
          head_sha: refs.head_sha
        },
        files: [
          {
            filename: 'src/app.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@'
          }
        ]
      })

      const changed_files = JSON.parse(
        await fs.readFile(
          path.join(
            prepared.input_bundle_root,
            'incremental-window',
            'changed-files.json'
          ),
          'utf8'
        )
      ) as { files: Array<{ path: string }> }
      const patch = await fs.readFile(
        path.join(
          prepared.input_bundle_root,
          'incremental-window',
          'incremental.patch'
        ),
        'utf8'
      )

      assert.deepStrictEqual(
        changed_files.files.map((item) => item.path),
        ['src/app.ts']
      )
      // The patch must be exactly the push window, not the whole pull request.
      // The fixture's head commit rewrites the same single line, so any patch
      // that reaches further back than the push would need a different marker
      // than the one expected here. Assert the concrete range instead of prose.
      assert.match(patch, /^-export const value = 1$/m)
      assert.match(patch, /^\+export const value = 2$/m)
      const hunk_count = (patch.match(/^@@/gm) ?? []).length
      assert.strictEqual(hunk_count, 1)
    } finally {
      if (previousServer === undefined) delete process.env['GITHUB_SERVER_URL']
      else process.env['GITHUB_SERVER_URL'] = previousServer
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  }
)
