import assert from 'node:assert/strict'
import test from 'node:test'

import type { Octokit } from 'octokit'
import { readSetupDeclaration } from '../../../src/reviews/shared/input-bundle.js'
import { fakeGitHub, githubFile, githubJson } from '../../github-client.js'

/**
 * Read setup declarations through an octokit whose Contents API is served by a
 * map from `path` to file text. `sha` is passed straight through `ref`; the
 * mock records the request so tests can assert the declaration is read at the
 * exact default-branch SHA, not a branch name.
 */
function octokitForContent(
  files: Record<string, string>,
  requests: Array<{ path: string; ref?: string }> = []
): Octokit {
  return fakeGitHub((request) => {
    const parsed = new URL(request.url)
    const query = parsed.searchParams
    const path = decodeURIComponent(
      parsed.pathname.split('/contents/')[1] ?? ''
    )
    const ref = query.get('ref') ?? undefined
    requests.push({ path, ...(ref !== undefined ? { ref } : {}) })
    const content = files[path]
    // A missing entry is a real 404, the only status that means "no declaration".
    if (content === undefined) return githubJson({ message: 'Not Found' }, 404)
    return githubFile(content, path)
  }).octokit
}

test('readSetupDeclaration returns the declaration text from the default branch SHA', async () => {
  const requests: Array<{ path: string; ref?: string }> = []
  const octokit = octokitForContent(
    { '.sec-review/setup.yml': 'setup:\n  - run: echo hi\n' },
    requests
  )

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'a'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.strictEqual(declaration, 'setup:\n  - run: echo hi\n')
  // Reads the exact commit, not a branch name, so a fork cannot change it.
  assert.deepStrictEqual(requests, [
    { path: '.sec-review/setup.yml', ref: 'a'.repeat(40) }
  ])
})

test('readSetupDeclaration returns null when the declaration is absent', async () => {
  const octokit = octokitForContent({ 'README.md': 'x\n' })

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'b'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.strictEqual(declaration, null)
})

test('readSetupDeclaration treats a whitespace-only declaration as absent', async () => {
  // A blank (but present) setup.yml must not reach the runner as a
  // `setup_declaration` value: the runner contract types that field as a
  // non-blank string, so a blank value would fail validation of the whole
  // workflow input and reject every review of the repository.
  const octokit = octokitForContent({ '.sec-review/setup.yml': '   \n\n' })

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'c'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.strictEqual(declaration, null)
})

test('readSetupDeclaration rejects an invalid declaration with repository context', async () => {
  // A present-but-invalid declaration is a maintainer error on the default
  // branch: it fails the run loudly (with owner/repo/ref/path attached) instead
  // of silently degrading to an unbootstrapped environment.
  const sha = 'd'.repeat(40)
  const octokit = octokitForContent({
    '.sec-review/setup.yml': 'setup:\n  - uses: actions/checkout@v4\n'
  })

  await assert.rejects(
    () =>
      readSetupDeclaration({
        octokit,
        default_sha: sha,
        owner_login: 'octo',
        repo_name: 'demo'
      }),
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
})

test('readSetupDeclaration propagates a non-404 read failure instead of skipping', async () => {
  // Only a 404 means "no declaration". Any other failure (403, 5xx, network)
  // must fail input preparation loudly rather than silently reviewing the
  // repository without the environment the default branch declared.
  // 403 is a real HTTP reply, so Octokit maps it to a RequestError with that status - which is
  // what the code under test must distinguish from a 404.
  const octokit = fakeGitHub(() =>
    githubJson({ message: 'Forbidden' }, 403)
  ).octokit

  await assert.rejects(
    () =>
      readSetupDeclaration({
        octokit,
        default_sha: 'e'.repeat(40),
        owner_login: 'octo',
        repo_name: 'demo'
      }),
    /Forbidden/
  )
})

test('readSetupDeclaration ignores a symlink entry, whose content is the target path', async () => {
  // GitHub returns a symlink as a single object too, but with `type: "symlink"`
  // and `content` set to the base64 of the *target path* (not the file body).
  // Treating it as a declaration would feed a path string to the parser; the
  // reader must treat any non-`file` entry as "no declaration".
  const octokit = fakeGitHub(() =>
    githubJson({
      type: 'symlink',
      target: '../shared/setup.yml',
      content: Buffer.from('../shared/setup.yml', 'utf8').toString('base64')
    })
  ).octokit

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'f'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.strictEqual(declaration, null)
})

test('readSetupDeclaration treats a directory entry as absent', async () => {
  const octokit = fakeGitHub(() =>
    githubJson([
      {
        type: 'file',
        path: '.sec-review/setup.yml/README.md',
        content: Buffer.from('x', 'utf8').toString('base64')
      }
    ])
  ).octokit

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'a'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.strictEqual(declaration, null)
})
