import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

test('readSetupDeclaration returns the declaration text from the default branch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-declaration-test-'))
  const previousServer = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${root}`
  try {
    // A bare remote at <root>/octo/demo.git to mirror buildGitRemoteUrl().
    const remote = path.join(root, 'octo', 'demo.git')
    const source = path.join(root, 'source')
    await fs.mkdir(path.dirname(remote), { recursive: true })
    await fs.mkdir(source, { recursive: true })
    await git(root, ['init', '--bare', remote])
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.mkdir(path.join(source, '.sec-review'), { recursive: true })
    await fs.writeFile(
      path.join(source, '.sec-review', 'setup.yml'),
      'setup:\n  - run: echo hi\n',
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'add setup'])
    const sha = await git(source, ['rev-parse', 'HEAD'])
    await git(source, ['remote', 'add', 'origin', remote])
    await git(source, ['push', 'origin', 'HEAD:refs/heads/main'])

    const { readSetupDeclaration } = await import('../../../src/reviews/shared/input-bundle.js')
    const declaration = await readSetupDeclaration({
      default_sha: sha,
      owner_login: 'octo',
      repo_name: 'demo'
    })

    assert.equal(declaration, 'setup:\n  - run: echo hi\n')
  } finally {
    process.env['GITHUB_SERVER_URL'] = previousServer
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readSetupDeclaration returns null when the declaration is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-declaration-missing-'))
  const previousServer = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${root}`
  try {
    const remote = path.join(root, 'octo', 'demo.git')
    const source = path.join(root, 'source')
    await fs.mkdir(path.dirname(remote), { recursive: true })
    await fs.mkdir(source, { recursive: true })
    await git(root, ['init', '--bare', remote])
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.writeFile(path.join(source, 'README.md'), 'x\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'init'])
    const sha = await git(source, ['rev-parse', 'HEAD'])
    await git(source, ['remote', 'add', 'origin', remote])
    await git(source, ['push', 'origin', 'HEAD:refs/heads/main'])

    const { readSetupDeclaration } = await import('../../../src/reviews/shared/input-bundle.js')
    const declaration = await readSetupDeclaration({
      default_sha: sha,
      owner_login: 'octo',
      repo_name: 'demo'
    })

    assert.equal(declaration, null)
  } finally {
    process.env['GITHUB_SERVER_URL'] = previousServer
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readSetupDeclaration treats a whitespace-only declaration as absent', async () => {
  // A blank (but present) setup.yml must not reach the runner as a
  // `setup_declaration` value: the runner contract types that field as a
  // non-blank string, so a blank value would fail validation of the whole
  // workflow input and reject every review of the repository.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-declaration-blank-'))
  const previousServer = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${root}`
  try {
    const remote = path.join(root, 'octo', 'demo.git')
    const source = path.join(root, 'source')
    await fs.mkdir(path.dirname(remote), { recursive: true })
    await fs.mkdir(source, { recursive: true })
    await git(root, ['init', '--bare', remote])
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.mkdir(path.join(source, '.sec-review'), { recursive: true })
    await fs.writeFile(path.join(source, '.sec-review', 'setup.yml'), '   \n\n', 'utf8')
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'add blank setup'])
    const sha = await git(source, ['rev-parse', 'HEAD'])
    await git(source, ['remote', 'add', 'origin', remote])
    await git(source, ['push', 'origin', 'HEAD:refs/heads/main'])

    const { readSetupDeclaration } = await import('../../../src/reviews/shared/input-bundle.js')
    const declaration = await readSetupDeclaration({
      default_sha: sha,
      owner_login: 'octo',
      repo_name: 'demo'
    })

    assert.equal(declaration, null)
  } finally {
    process.env['GITHUB_SERVER_URL'] = previousServer
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readSetupDeclaration rejects an invalid declaration with repository context', async () => {
  // A present-but-invalid declaration is a maintainer error on the default
  // branch: it fails the run loudly (with owner/repo/ref/path attached) instead
  // of silently degrading to an unbootstrapped environment.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-declaration-invalid-'))
  const previousServer = process.env['GITHUB_SERVER_URL']
  process.env['GITHUB_SERVER_URL'] = `file://${root}`
  try {
    const remote = path.join(root, 'octo', 'demo.git')
    const source = path.join(root, 'source')
    await fs.mkdir(path.dirname(remote), { recursive: true })
    await fs.mkdir(source, { recursive: true })
    await git(root, ['init', '--bare', remote])
    await git(source, ['init'])
    await git(source, ['config', 'user.name', 'Test User'])
    await git(source, ['config', 'user.email', 'test@example.com'])
    await fs.mkdir(path.join(source, '.sec-review'), { recursive: true })
    await fs.writeFile(
      path.join(source, '.sec-review', 'setup.yml'),
      'setup:\n  - uses: actions/checkout@v4\n',
      'utf8'
    )
    await git(source, ['add', '.'])
    await git(source, ['commit', '-m', 'add invalid setup'])
    const sha = await git(source, ['rev-parse', 'HEAD'])
    await git(source, ['remote', 'add', 'origin', remote])
    await git(source, ['push', 'origin', 'HEAD:refs/heads/main'])

    const { readSetupDeclaration } = await import('../../../src/reviews/shared/input-bundle.js')
    await assert.rejects(
      () => readSetupDeclaration({ default_sha: sha, owner_login: 'octo', repo_name: 'demo' }),
      (error: unknown) => {
        const e = error as {
          name?: string
          owner_login?: string
          repo_name?: string
          ref?: string
          path?: string
        }
        return (
          e.name === 'SetupDeclarationError' &&
          e.owner_login === 'octo' &&
          e.repo_name === 'demo' &&
          e.ref === sha &&
          e.path === '.sec-review/setup.yml'
        )
      }
    )
  } finally {
    process.env['GITHUB_SERVER_URL'] = previousServer
    await fs.rm(root, { recursive: true, force: true })
  }
})
