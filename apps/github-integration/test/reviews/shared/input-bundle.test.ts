import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitHubAppOctokit } from '../../../src/github/octokit.js'
import { readSetupDeclaration } from '../../../src/reviews/shared/input-bundle.js'

/**
 * Read setup declarations through an octokit whose Contents API is served by a
 * map from `path` to file text. `sha` is passed straight through `ref`; the
 * mock records the request so tests can assert the declaration is read at the
 * exact default-branch SHA, not a branch name.
 */
function octokitForContent(
  files: Record<string, string>,
  requests: Array<{ path: string; ref?: string }> = []
): GitHubAppOctokit {
  return {
    rest: {
      repos: {
        getContent: async ({ path, ref }: { path: string; ref?: string }) => {
          requests.push({ path, ...(ref !== undefined ? { ref } : {}) })
          const content = files[path]
          if (content === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 })
          }
          return {
            data: {
              type: 'file',
              content: Buffer.from(content, 'utf8').toString('base64')
            }
          }
        }
      }
    }
  } as unknown as GitHubAppOctokit
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

  assert.equal(declaration, 'setup:\n  - run: echo hi\n')
  // Reads the exact commit, not a branch name, so a fork cannot change it.
  assert.deepEqual(requests, [
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

  assert.equal(declaration, null)
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

  assert.equal(declaration, null)
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
  const octokit = {
    rest: {
      repos: {
        getContent: async () => {
          throw Object.assign(new Error('Forbidden'), { status: 403 })
        }
      }
    }
  } as unknown as GitHubAppOctokit

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
  const octokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            type: 'symlink',
            target: '../shared/setup.yml',
            content: Buffer.from('../shared/setup.yml', 'utf8').toString(
              'base64'
            )
          }
        })
      }
    }
  } as unknown as GitHubAppOctokit

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'f'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.equal(declaration, null)
})

test('readSetupDeclaration treats a directory entry as absent', async () => {
  const octokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: [
            {
              type: 'file',
              path: '.sec-review/setup.yml/README.md',
              content: Buffer.from('x', 'utf8').toString('base64')
            }
          ]
        })
      }
    }
  } as unknown as GitHubAppOctokit

  const declaration = await readSetupDeclaration({
    octokit,
    default_sha: 'a'.repeat(40),
    owner_login: 'octo',
    repo_name: 'demo'
  })

  assert.equal(declaration, null)
})
