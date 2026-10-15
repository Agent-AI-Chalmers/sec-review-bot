import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  configuredGitTimeoutMs,
  createWorkspaceSnapshotTar,
  materializeWorkspaceWithCommitHistory,
  readRepositoryFileAtRef,
  retryGitFetch,
  withConfiguredGitFetchProxy
} from '../../src/artifacts/git-workspace.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

test('retryGitFetch retries with exponential delays and then succeeds', async () => {
  let attempts = 0
  const delays: number[] = []

  await retryGitFetch(
    async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('temporary fetch failure')
      }
    },
    async (delay_ms) => {
      delays.push(delay_ms)
    }
  )

  assert.equal(attempts, 3)
  assert.deepEqual(delays, [1000, 2000])
})

test('retryGitFetch preserves the final fetch error', async () => {
  const failure = new Error('permanent fetch failure')
  let attempts = 0

  await assert.rejects(
    retryGitFetch(
      async () => {
        attempts += 1
        throw failure
      },
      async () => {}
    ),
    (error) => error === failure
  )

  assert.equal(attempts, 3)
})

test('withConfiguredGitFetchProxy leaves fetch options unchanged without a proxy', () => {
  const options = {
    config: ['credential.helper='],
    env: { GIT_TERMINAL_PROMPT: '0' }
  }

  assert.equal(withConfiguredGitFetchProxy(options, ''), options)
  assert.equal(withConfiguredGitFetchProxy(options, '  '), options)
})

test('withConfiguredGitFetchProxy adds a fetch-only Git proxy', () => {
  const options = {
    config: ['credential.helper='],
    env: { GIT_TERMINAL_PROMPT: '0' }
  }

  assert.deepEqual(withConfiguredGitFetchProxy(options, ' http://host.docker.internal:7897 '), {
    config: ['credential.helper='],
    env: {
      GIT_TERMINAL_PROMPT: '0',
      http_proxy: 'http://host.docker.internal:7897',
      https_proxy: 'http://host.docker.internal:7897'
    }
  })
})

test('materializeWorkspaceWithCommitHistory keeps git diffs but removes fetch metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-git-workspace-test-'))
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'README.md'), 'before\n', 'utf8')
    await git(source, ['add', 'README.md'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])
    await fs.writeFile(path.join(source, 'README.md'), 'after\n', 'utf8')
    await git(source, ['commit', '-am', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    assert.equal(await git(workspace, ['rev-parse', 'HEAD']), head_sha)
    assert.equal(
      await git(workspace, ['diff', '--name-only', `${base_sha}..${head_sha}`]),
      'README.md'
    )
    assert.equal(await git(workspace, ['remote']), '')
    await assert.rejects(fs.stat(path.join(workspace, '.git', 'FETCH_HEAD')))
    await assert.rejects(fs.stat(path.join(workspace, '.git', 'logs')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('materializeWorkspaceWithCommitHistory uses a shallow workspace for single-ref materialization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-git-shallow-test-'))
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'README.md'), 'before\n', 'utf8')
    await git(source, ['add', 'README.md'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])
    await fs.writeFile(path.join(source, 'README.md'), 'after\n', 'utf8')
    await git(source, ['commit', '-am', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [head_sha]
    })

    assert.equal(await git(workspace, ['rev-parse', 'HEAD']), head_sha)
    assert.equal(await git(workspace, ['rev-list', '--count', 'HEAD']), '1')
    assert.equal(await git(workspace, ['rev-parse', '--is-shallow-repository']), 'true')
    await assert.rejects(git(workspace, ['cat-file', '-e', `${base_sha}^{commit}`]))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('materializeWorkspaceWithCommitHistory rejects refs that look like git options', async () => {
  await assert.rejects(
    materializeWorkspaceWithCommitHistory({
      workspace_path: path.join(os.tmpdir(), 'sec-review-unused-workspace'),
      git_remote_url: '/tmp/sec-review-unused-source',
      refs: ['--upload-pack=sh']
    }),
    /refs must not start/
  )
})

test('createWorkspaceSnapshotTar compacts git objects before archiving', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-git-snapshot-test-'))
  try {
    const workspace = path.join(root, 'workspace')
    const tar_path = path.join(root, 'workspace.snapshot.tar')
    await fs.mkdir(workspace, { recursive: true })
    await git(workspace, ['init'])
    await git(workspace, ['config', 'user.name', 'Test User'])
    await git(workspace, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(workspace, 'README.md'), 'hello\n', 'utf8')
    await git(workspace, ['add', 'README.md'])
    await git(workspace, ['commit', '-m', 'init'])

    const before = await git(workspace, ['count-objects', '-v'])
    assert.match(before, /count: [1-9]/)

    await createWorkspaceSnapshotTar({
      workspace_path: workspace,
      tar_path
    })

    const after = await git(workspace, ['count-objects', '-v'])
    assert.match(after, /count: 0/)
    await fs.stat(tar_path)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('createWorkspaceSnapshotTar restores a self-consistent git workspace from the tarball', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-git-restore-test-'))
  try {
    const workspace = path.join(root, 'workspace')
    const restoredParent = path.join(root, 'restored')
    const restoredWorkspace = path.join(restoredParent, 'workspace')
    const tar_path = path.join(root, 'workspace.snapshot.tar')
    await fs.mkdir(workspace, { recursive: true })
    await git(workspace, ['init'])
    await git(workspace, ['config', 'user.name', 'Test User'])
    await git(workspace, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(workspace, 'README.md'), 'before\n', 'utf8')
    await git(workspace, ['add', 'README.md'])
    await git(workspace, ['commit', '-m', 'before'])
    const base_sha = await git(workspace, ['rev-parse', 'HEAD'])
    await fs.writeFile(path.join(workspace, 'README.md'), 'after\n', 'utf8')
    await git(workspace, ['commit', '-am', 'after'])
    const head_sha = await git(workspace, ['rev-parse', 'HEAD'])

    await createWorkspaceSnapshotTar({
      workspace_path: workspace,
      tar_path
    })

    await fs.mkdir(restoredParent, { recursive: true })
    await execFileAsync('tar', ['-xf', tar_path, '-C', restoredParent])

    await git(restoredWorkspace, ['fsck', '--strict'])
    assert.equal(await git(restoredWorkspace, ['rev-parse', 'HEAD']), head_sha)
    assert.equal(
      await git(restoredWorkspace, ['diff', '--name-only', `${base_sha}..${head_sha}`]),
      'README.md'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readRepositoryFileAtRef returns file content at a commit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-read-file-test-'))
  try {
    const source = path.join(root, 'source')
    await fs.mkdir(path.join(source, '.sec-review'), { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(
      path.join(source, '.sec-review', 'setup.yml'),
      'setup:\n  - run: echo hi\n',
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'add setup'])
    const sha = await git(source, ['rev-parse', 'HEAD'])

    const content = await readRepositoryFileAtRef({
      commit_sha: sha,
      file_path: '.sec-review/setup.yml',
      git_remote_url: source
    })
    assert.equal(content, 'setup:\n  - run: echo hi\n')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readRepositoryFileAtRef returns null when the file does not exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-review-read-file-missing-'))
  try {
    const source = path.join(root, 'source')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'README.md'), 'x\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'init'])
    const sha = await git(source, ['rev-parse', 'HEAD'])

    const content = await readRepositoryFileAtRef({
      commit_sha: sha,
      file_path: '.sec-review/setup.yml',
      git_remote_url: source
    })
    assert.equal(content, null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readRepositoryFileAtRef rejects unsafe file paths', async () => {
  await assert.rejects(
    () =>
      readRepositoryFileAtRef({
        commit_sha: 'deadbeef',
        file_path: '../escape.yml',
        git_remote_url: 'file:///does/not/matter'
      }),
    /invalid file path/
  )
})

test('readRepositoryFileAtRef rejects absolute and option-looking file paths', async () => {
  for (const file_path of ['/etc/passwd', '--output=/tmp/x', '-p']) {
    await assert.rejects(
      () =>
        readRepositoryFileAtRef({
          commit_sha: 'deadbeef',
          file_path,
          git_remote_url: 'file:///does/not/matter'
        }),
      /invalid file path/
    )
  }
})

test('readRepositoryFileAtRef rejects a non-hexadecimal commit SHA', async () => {
  // A SHA is passed straight to `git fetch` as a ref; reject anything that is
  // not a plain hex object name so it cannot become a git option or a revision
  // expression.
  for (const commit_sha of ['--upload-pack=touch /tmp/pwned', 'HEAD@{0}', 'refs/heads/main', '']) {
    await assert.rejects(
      () =>
        readRepositoryFileAtRef({
          commit_sha,
          file_path: '.sec-review/setup.yml',
          git_remote_url: 'file:///does/not/matter'
        }),
      /hexadecimal commit SHA/
    )
  }
})

test('configuredGitTimeoutMs defaults and reads a validated override', () => {
  assert.equal(configuredGitTimeoutMs(undefined), 600_000)
  assert.equal(configuredGitTimeoutMs(''), 600_000)
  assert.equal(configuredGitTimeoutMs('1500'), 1500)
})

test('configuredGitTimeoutMs rejects a non-positive or malformed override', () => {
  for (const value of ['0', '-1', 'abc', '1.5', '10s']) {
    assert.throws(() => configuredGitTimeoutMs(value), /GITHUB_INTEGRATION_GIT_TIMEOUT_MS/)
  }
})

test('a git command that exceeds the timeout is killed, not left running', async () => {
  // Any real git invocation takes more than 1ms, so a 1ms budget must kill it.
  // The point is that the timeout is enforced: the command rejects instead of
  // hanging. A killed command must never be downgraded to "the file is absent".
  const previous = process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS']
  process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS'] = '1'
  try {
    await assert.rejects(() =>
      readRepositoryFileAtRef({
        commit_sha: 'a'.repeat(40),
        file_path: '.sec-review/setup.yml',
        git_remote_url: 'file:///does/not/matter'
      })
    )
  } finally {
    if (previous === undefined) {
      delete process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS']
    } else {
      process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS'] = previous
    }
  }
})
