import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  createWorkspaceSnapshotTar,
  materializeWorkspaceWithCommitHistory
} from '../../infrastructure/runner/git-workspace.js'

const execFileAsync = promisify(execFile)

async function git (cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

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
    assert.equal(await git(workspace, ['diff', '--name-only', `${base_sha}..${head_sha}`]), 'README.md')
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
    await execFileAsync('tar', [
      '-xf',
      tar_path,
      '-C',
      restoredParent
    ])

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
