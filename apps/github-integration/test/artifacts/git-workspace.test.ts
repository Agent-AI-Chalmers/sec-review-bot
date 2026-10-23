import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  configuredGitTimeoutMs,
  exportWorkspaceWindow,
  createWorkspaceSnapshotTar,
  exportWorkspaceDiff,
  materializeWorkspaceWithCommitHistory,
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

  assert.strictEqual(attempts, 3)
  assert.deepStrictEqual(delays, [1000, 2000])
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

  assert.strictEqual(attempts, 3)
})

test('withConfiguredGitFetchProxy leaves fetch options unchanged without a proxy', () => {
  const options = {
    config: ['credential.helper='],
    env: { GIT_TERMINAL_PROMPT: '0' }
  }

  assert.strictEqual(withConfiguredGitFetchProxy(options, ''), options)
  assert.strictEqual(withConfiguredGitFetchProxy(options, '  '), options)
})

test('withConfiguredGitFetchProxy adds a fetch-only Git proxy', () => {
  const options = {
    config: ['credential.helper='],
    env: { GIT_TERMINAL_PROMPT: '0' }
  }

  assert.deepStrictEqual(
    withConfiguredGitFetchProxy(options, ' http://host.docker.internal:7897 '),
    {
      config: ['credential.helper='],
      env: {
        GIT_TERMINAL_PROMPT: '0',
        http_proxy: 'http://host.docker.internal:7897',
        https_proxy: 'http://host.docker.internal:7897'
      }
    }
  )
})

test('materializeWorkspaceWithCommitHistory keeps git diffs but removes fetch metadata', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-workspace-test-')
  )
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
      refs: [base_sha, head_sha],
      window_base_sha: base_sha
    })

    assert.strictEqual(await git(workspace, ['rev-parse', 'HEAD']), head_sha)
    assert.strictEqual(
      await git(workspace, ['diff', '--name-only', `${base_sha}..${head_sha}`]),
      'README.md'
    )
    // The pinned refs are the only thing keeping base reachable after sanitize, so
    // they must name their role: a caller (or an agent reading the workspace) has to
    // be able to tell which commit is the window start without knowing the array order.
    assert.strictEqual(
      await git(workspace, ['rev-parse', 'refs/sec-review/base']),
      base_sha
    )
    assert.strictEqual(
      await git(workspace, ['rev-parse', 'refs/sec-review/head']),
      head_sha
    )
    assert.strictEqual(await git(workspace, ['remote']), '')
    await assert.rejects(fs.stat(path.join(workspace, '.git', 'FETCH_HEAD')))
    await assert.rejects(fs.stat(path.join(workspace, '.git', 'logs')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('materializeWorkspaceWithCommitHistory names the window base, not the first ref', async () => {
  // Pull request materialization passes [pr.base_sha, window.base_sha, ...], and on
  // `synchronize` the window base is the previous head, not the pull request's base. Naming
  // the first ref `base` would make refs/sec-review/base point at the target branch tip, and a
  // diff against it would review the wrong range while claiming to be the review window.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-window-base-test-')
  )
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    const commit = async (content: string): Promise<string> => {
      await fs.writeFile(path.join(source, 'README.md'), content, 'utf8')
      await git(source, ['add', 'README.md'])
      await git(source, ['commit', '-m', content])
      return git(source, ['rev-parse', 'HEAD'])
    }
    const pr_base_sha = await commit('pr base\n')
    const window_base_sha = await commit('previous head\n')
    const head_sha = await commit('current head\n')

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [pr_base_sha, window_base_sha, head_sha],
      window_base_sha
    })

    assert.strictEqual(
      await git(workspace, ['rev-parse', 'refs/sec-review/base']),
      window_base_sha
    )
    assert.strictEqual(
      await git(workspace, ['rev-parse', 'refs/sec-review/head']),
      head_sha
    )
    // The pull request's own base is still pinned, so its commit survives sanitize; it just
    // does not claim to be the window base.
    assert.strictEqual(
      await git(workspace, ['rev-parse', 'refs/sec-review/pinned-0']),
      pr_base_sha
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('materializeWorkspaceWithCommitHistory rejects a window base outside refs', async () => {
  // A window base that is not among the refs is never fetched, so it cannot be pinned. Failing
  // here keeps refs/sec-review/base from silently going missing while callers assume it exists.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-window-base-reject-test-')
  )
  try {
    await assert.rejects(
      materializeWorkspaceWithCommitHistory({
        workspace_path: path.join(root, 'workspace'),
        git_remote_url: path.join(root, 'source'),
        refs: ['a'.repeat(40)],
        window_base_sha: 'b'.repeat(40)
      }),
      /window_base_sha must be one of refs/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('materializeWorkspaceWithCommitHistory uses a shallow workspace for single-ref materialization', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-shallow-test-')
  )
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

    assert.strictEqual(await git(workspace, ['rev-parse', 'HEAD']), head_sha)
    assert.strictEqual(
      await git(workspace, ['rev-list', '--count', 'HEAD']),
      '1'
    )
    assert.strictEqual(
      await git(workspace, ['rev-parse', '--is-shallow-repository']),
      'true'
    )
    await assert.rejects(
      git(workspace, ['cat-file', '-e', `${base_sha}^{commit}`])
    )
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
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-snapshot-test-')
  )
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
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-restore-test-')
  )
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
    assert.strictEqual(
      await git(restoredWorkspace, ['rev-parse', 'HEAD']),
      head_sha
    )
    assert.strictEqual(
      await git(restoredWorkspace, [
        'diff',
        '--name-only',
        `${base_sha}..${head_sha}`
      ]),
      'README.md'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test('configuredGitTimeoutMs defaults and reads a validated override', (t) => {
  const previous = process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS
  t.after(() => {
    if (previous === undefined)
      delete process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS
    else process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS = previous
  })
  delete process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS
  assert.strictEqual(configuredGitTimeoutMs(), 600_000)
  process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS = '1500'
  assert.strictEqual(configuredGitTimeoutMs(), 1500)
})

test('configuredGitTimeoutMs rejects a non-positive or malformed override', (t) => {
  const previous = process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS
  t.after(() => {
    if (previous === undefined)
      delete process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS
    else process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS = previous
  })
  for (const value of ['', '0', '-1', 'abc', '1.5', '10s']) {
    process.env.GITHUB_INTEGRATION_GIT_TIMEOUT_MS = value
    assert.throws(
      () => configuredGitTimeoutMs(),
      /GITHUB_INTEGRATION_GIT_TIMEOUT_MS/
    )
  }
})

test('a git command that exceeds the timeout is killed, not left running', async () => {
  // Any real git invocation takes more than 1ms, so a 1ms budget must kill it.
  // The point is that the timeout is enforced: the command rejects instead of
  // hanging on a remote that never answers.
  const previous = process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS']
  process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS'] = '1'
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-timeout-test-'))
  try {
    await assert.rejects(() =>
      materializeWorkspaceWithCommitHistory({
        workspace_path: path.join(root, 'workspace'),
        refs: ['main'],
        // An unroutable address: without the timeout this would hang.
        git_remote_url: 'http://10.255.255.1:9/octo/demo.git'
      })
    )
  } finally {
    if (previous === undefined) {
      delete process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS']
    } else {
      process.env['GITHUB_INTEGRATION_GIT_TIMEOUT_MS'] = previous
    }
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceDiff returns changes the files API omits its patch for', async () => {
  // The motivating regression: GitHub returns a large pull request's file list
  // but leaves `patch` null for some entries, so a patch assembled from the API
  // silently drops them from the review. The workspace has real commits, so the
  // exported diff must still contain every change -- here a renamed file with no
  // content change and a large rewritten file, both of which lose their patch.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'sec-review-git-workspace-test-')
  )
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'old-name.md'), 'stable\n', 'utf8')
    await fs.writeFile(
      path.join(source, 'big.html'),
      'line\n'.repeat(20_000),
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])

    await git(source, ['mv', 'old-name.md', 'new-name.md'])
    await fs.writeFile(
      path.join(source, 'big.html'),
      'changed line\n'.repeat(20_000),
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    const diff = await exportWorkspaceDiff({
      workspace_path: workspace,
      base_sha,
      head_sha
    })

    // Both changes survive, and the large file's content is neither truncated
    // nor cut short by an execFile output-buffer limit: every rewritten line of
    // big.html must appear.
    assert.match(diff, /rename from old-name\.md/)
    assert.match(diff, /rename to new-name\.md/)
    assert.match(diff, /b\/big\.html/)
    const changed_lines = diff.match(/^\+changed line$/gm) ?? []
    assert.strictEqual(changed_lines.length, 20_000)
    assert.match(diff, /changed line\n\+changed line\n/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceDiff rejects refs that are empty or look like options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-diff-ref-test-'))
  try {
    await git(root, ['init'])
    for (const [base_sha, head_sha] of [
      ['', 'HEAD'],
      ['HEAD', ''],
      ['--output=/tmp/x', 'HEAD']
    ] as const) {
      await assert.rejects(() =>
        exportWorkspaceDiff({ workspace_path: root, base_sha, head_sha })
      )
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function makeBinaryDiffWorkspace(root: string): Promise<{
  workspace: string
  base_sha: string
  head_sha: string
}> {
  const source = path.join(root, 'source')
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(source, { recursive: true })
  await git(source, ['init'])
  await git(source, ['config', 'user.name', 'Test User'])
  await git(source, ['config', 'user.email', 'test@example.com'])
  // A NUL byte in the first 8 KiB is what makes git treat the file as binary.
  await fs.writeFile(
    path.join(source, 'blob.bin'),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x41, 0x00, 0x0a])
  )
  await git(source, ['add', '.'])
  await git(source, ['commit', '-m', 'before'])
  const base_sha = await git(source, ['rev-parse', 'HEAD'])
  await fs.writeFile(
    path.join(source, 'blob.bin'),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x5a, 0x00, 0x0a])
  )
  await git(source, ['commit', '-am', 'after'])
  const head_sha = await git(source, ['rev-parse', 'HEAD'])
  await materializeWorkspaceWithCommitHistory({
    workspace_path: workspace,
    git_remote_url: source,
    refs: [base_sha, head_sha]
  })
  return { workspace, base_sha, head_sha }
}

test('exportWorkspaceDiff ignores an external diff command injected through the environment', async () => {
  // GIT_CONFIG_* environment variables outrank the -c options this module passes.
  // Setting diff.external there replaces the diff entirely with the output of an
  // arbitrary command, which bypassed --no-textconv when measured. The export must
  // ignore that injection, so the binary placeholder still has to appear.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-binary-env-'))
  try {
    const { workspace, base_sha, head_sha } =
      await makeBinaryDiffWorkspace(root)

    const previous = new Map<string, string | undefined>()
    for (const name of [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0'
    ]) {
      previous.set(name, process.env[name])
    }
    process.env['GIT_CONFIG_COUNT'] = '1'
    process.env['GIT_CONFIG_KEY_0'] = 'diff.external'
    process.env['GIT_CONFIG_VALUE_0'] = '/bin/echo INJECTED-EXTERNAL-DIFF'
    try {
      // Guard the guard: the injection is real, so removing the sanitizer turns
      // this test red rather than leaving it vacuously green.
      const injected = await execFileAsync(
        'git',
        ['diff', '--no-color', `${base_sha}..${head_sha}`],
        {
          cwd: workspace
        }
      )
      assert.match(injected.stdout, /INJECTED-EXTERNAL-DIFF/)

      const diff = await exportWorkspaceDiff({
        workspace_path: workspace,
        base_sha,
        head_sha
      })
      assert.doesNotMatch(diff, /INJECTED-EXTERNAL-DIFF/)
      assert.match(diff, /Binary files .* differ/)
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceDiff ignores a repository diff driver that expands binary files', async () => {
  // A checked-in .gitattributes can map a path to a diff driver whose textconv
  // command is configured in the repository's own git config, so no injected
  // configuration is needed. The textconv below echoes each side's payload,
  // which makes the sides differ and forces git to print binary content as text
  // lines when the driver runs. This is the textconv path; --no-ext-diff does
  // not cover it, so the assertion here is what pins --no-textconv in place.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-binary-attr-'))
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    const textconv_path = path.join(root, 'textconv.sh')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, '.gitattributes'), '* diff=evil\n')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'attributes'])
    await fs.writeFile(
      path.join(source, 'blob.bin'),
      Buffer.from([0x00, 0x01, 0x41, 0x00, 0x0a])
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])
    await fs.writeFile(
      path.join(source, 'blob.bin'),
      Buffer.from([0x00, 0x01, 0x5a, 0x00, 0x0a])
    )
    await git(source, ['commit', '-am', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await fs.writeFile(
      textconv_path,
      '#!/bin/sh\necho "TEXTCONV-EXPANDED payload=$(od -An -c "$1" | tr -d " \\n")"\n',
      { encoding: 'utf8', mode: 0o700 }
    )

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })
    await git(workspace, ['config', 'diff.evil.textconv', textconv_path])

    // Guard the guard: the fixture must be able to produce the attack, so
    // dropping --no-textconv turns this test red instead of leaving it green.
    const expanded = await git(workspace, [
      'diff',
      '--no-color',
      `${base_sha}..${head_sha}`
    ])
    assert.match(expanded, /TEXTCONV-EXPANDED/)

    const diff = await exportWorkspaceDiff({
      workspace_path: workspace,
      base_sha,
      head_sha
    })
    assert.doesNotMatch(diff, /TEXTCONV-EXPANDED/)
    assert.match(diff, /Binary files .* differ/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceDiff excludes changes that only landed on the base branch', async () => {
  // GitHub reports `pull_request.base.sha` as the base branch tip, not the point
  // where the PR branched off. When the base branch advances after the branch
  // point, a two-dot diff compares the two trees and renders the base branch's
  // own new work as if the PR deleted it, so the agent would review and report
  // changes that are not part of the pull request. The diff must be computed from
  // the merge base instead.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-diverge-test-'))
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init', '-b', 'main'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'app.txt'), 'base line\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'branch point'])
    await git(source, ['branch', 'feature'])

    // The base branch moves on after the PR branched off.
    await fs.writeFile(
      path.join(source, 'app.txt'),
      'base line\nbase-branch-only line\n',
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'base branch work'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])

    // The PR adds its own line on top of the branch point.
    await git(source, ['checkout', 'feature'])
    await fs.writeFile(
      path.join(source, 'app.txt'),
      'base line\npr-only line\n',
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'pr work'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    // The fixture must really be the reported failure mode rather than a
    // fast-forward: the base branch tip is not an ancestor of the PR head, so a
    // two-dot comparison of the two trees would show the base branch's own line
    // as a PR deletion. The assertion below therefore fails if the export ever
    // reverts to two dots.
    const diff = await exportWorkspaceDiff({
      workspace_path: workspace,
      base_sha,
      head_sha
    })
    assert.match(diff, /\+pr-only line/)
    assert.doesNotMatch(diff, /base-branch-only line/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceWindow keeps patches for paths git would quote', async () => {
  // Git's human-readable output quotes and octal-escapes paths containing a tab, quote,
  // newline, or non-ASCII byte. Parsing that form would leave the path as a quoted literal,
  // so it would never match the diff section and the patch would be dropped without a word --
  // exactly the failure this export exists to prevent. Reading paths with `-z` avoids the
  // quoting entirely.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'git-workspace-quoted-paths-')
  )
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'plain.txt'), 'base\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])

    const awkward = ['file\tname.txt', 'quote"name.txt', '中文名.txt']
    for (const name of awkward) {
      await fs.writeFile(path.join(source, name), 'content\n', 'utf8')
    }
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    const exported = await exportWorkspaceWindow({
      workspace_path: workspace,
      base_sha,
      head_sha
    })

    assert.deepStrictEqual(
      exported.files.map((file) => file.filename).sort(),
      [...awkward].sort()
    )
    for (const file of exported.files) {
      assert.ok(
        file.patch !== null,
        `${file.filename} lost its patch; git quoted the path`
      )
      assert.match(file.patch, /\+content/)
      assert.match(file.patch, /^diff --git /)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceWindow reports line counts for ordinary, renamed, and deleted files', async () => {
  // `--numstat -z` puts an ordinary file's path in the third tab field on the same line, while a
  // rename leaves that field empty and puts both paths in their own NUL fields. Reading only the
  // NUL form made every ordinary file's counts miss, so the agent-facing list reported 0/0 for
  // changes it had just described as modifications.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'git-workspace-numstat-')
  )
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'plain.txt'), 'a\nb\nc\n', 'utf8')
    await fs.writeFile(path.join(source, 'moved.txt'), 'x\ny\n', 'utf8')
    await fs.writeFile(path.join(source, 'gone.txt'), 'g1\ng2\ng3\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])

    await fs.writeFile(
      path.join(source, 'plain.txt'),
      'a\nb\nc\nd\ne\n',
      'utf8'
    )
    await git(source, ['mv', 'moved.txt', 'renamed.txt'])
    await git(source, ['rm', '-q', 'gone.txt'])
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-m', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    const exported = await exportWorkspaceWindow({
      workspace_path: workspace,
      base_sha,
      head_sha
    })
    const by_name = new Map(exported.files.map((file) => [file.filename, file]))

    assert.deepStrictEqual(
      {
        additions: by_name.get('plain.txt')?.additions,
        deletions: by_name.get('plain.txt')?.deletions
      },
      { additions: 2, deletions: 0 }
    )
    assert.deepStrictEqual(
      {
        additions: by_name.get('gone.txt')?.additions,
        deletions: by_name.get('gone.txt')?.deletions
      },
      { additions: 0, deletions: 3 }
    )
    // A pure rename changes no lines, and it must still be listed.
    assert.deepStrictEqual(
      {
        status: by_name.get('renamed.txt')?.status,
        additions: by_name.get('renamed.txt')?.additions,
        deletions: by_name.get('renamed.txt')?.deletions
      },
      { status: 'renamed', additions: 0, deletions: 0 }
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceWindow keeps line counts for a path containing a tab', async () => {
  // `-z` disables git's quoting, which also stops it escaping a tab inside the path:
  //   `<added>\t<deleted>\tfile\tname.txt\0`
  // Splitting the record on every tab truncates the path to `file`, so its counts never match
  // the name-status entry and fall back to 0/0 for a file the patch clearly modifies. Only the
  // first two tabs delimit the counts.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'git-workspace-tab-path-')
  )
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    const tabbed = 'file\tname.txt'
    await fs.writeFile(path.join(source, tabbed), 'a\n', 'utf8')
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-m', 'before'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])

    await fs.writeFile(path.join(source, tabbed), 'a\nb\nc\n', 'utf8')
    await git(source, ['add', '-A'])
    await git(source, ['commit', '-m', 'after'])
    const head_sha = await git(source, ['rev-parse', 'HEAD'])

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    const exported = await exportWorkspaceWindow({
      workspace_path: workspace,
      base_sha,
      head_sha
    })
    const entry = exported.files.find((file) => file.filename === tabbed)
    assert.ok(entry !== undefined, 'the tab path is missing from the file list')
    assert.deepStrictEqual(
      { additions: entry.additions, deletions: entry.deletions },
      { additions: 2, deletions: 0 }
    )
    assert.match(entry.patch ?? '', /\+b/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('exportWorkspaceWindow lists every commit in the range, past the compare page size', async () => {
  // The compare API returns at most 250 commits per page, so a long window cannot be described
  // by a single call. The workspace holds the history, and `git rev-list` has no page size: the
  // list must match the range exactly however many commits it contains.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'git-workspace-many-commits-')
  )
  try {
    const source = path.join(root, 'source')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(source, { recursive: true })
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'f.txt'), 'start\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'base'])
    const base_sha = await git(source, ['rev-parse', 'HEAD'])

    // 260 commits clears the compare endpoint's 250-commit page.
    await execFileAsync(
      'bash',
      [
        '-c',
        'for i in $(seq 1 260); do echo "line$i" >> f.txt; ' +
          'git -c user.name=t -c user.email=t@t commit -qam "c$i"; done'
      ],
      { cwd: source }
    )
    const head_sha = await git(source, ['rev-parse', 'HEAD'])
    const expected = Number(
      await git(source, ['rev-list', '--count', `${base_sha}..${head_sha}`])
    )
    assert.ok(expected > 250, `fixture only produced ${expected} commits`)

    await materializeWorkspaceWithCommitHistory({
      workspace_path: workspace,
      git_remote_url: source,
      refs: [base_sha, head_sha]
    })

    const exported = await exportWorkspaceWindow({
      workspace_path: workspace,
      base_sha,
      head_sha
    })
    assert.strictEqual(exported.commit_shas.length, expected)
    // `--reverse` keeps the list in application order, ending at the head commit.
    assert.strictEqual(exported.commit_shas.at(-1), head_sha)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
