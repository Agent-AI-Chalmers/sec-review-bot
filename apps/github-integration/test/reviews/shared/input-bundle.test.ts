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
