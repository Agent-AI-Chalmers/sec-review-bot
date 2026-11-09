import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Octokit } from 'octokit'
import {
  archiveInputBundle,
  archiveInputBundleAndBuildInput,
  assertWorkflowInputFits,
  readSetupDeclaration
} from '../../../src/reviews/shared/input-bundle.js'
import { MAX_WORKFLOW_INPUT_BYTES } from '../../../src/execution/input.js'
import { fakeGitHub, githubFile, githubJson } from '../../github-client.js'

/**
 * Read setup declarations through an octokit whose Git Trees and Contents APIs use a
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
    if (parsed.pathname.includes('/git/trees/')) {
      const subtree = parsed.pathname.endsWith('/' + '1'.repeat(40))
      return githubJson({
        truncated: false,
        tree: subtree
          ? Object.keys(files).map((file) => ({
              path: file.split('/')[1],
              type: 'blob',
              mode: '100644',
              sha: '2'.repeat(40)
            }))
          : Object.keys(files).some((file) => file.startsWith('.sec-review/'))
            ? [
                {
                  path: '.sec-review',
                  type: 'tree',
                  mode: '040000',
                  sha: '1'.repeat(40)
                }
              ]
            : []
      })
    }
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
  // A blank (but present) setup.yml must not reach the Execution Worker as a
  // `setup_declaration` value: the execution contract types that field as a
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

for (const [name, parentMode, parentType, fileMode, fileType] of [
  ['symlink to a regular file', '040000', 'tree', '120000', 'blob'],
  ['symlinked parent directory', '120000', 'blob', '100644', 'blob'],
  ['directory', '040000', 'tree', '040000', 'tree'],
  ['submodule', '040000', 'tree', '160000', 'commit']
]) {
  test(`readSetupDeclaration ignores a ${name} even if Contents would return file contents`, async () => {
    const { octokit, requests } = fakeGitHub(({ url }) => {
      const pathname = decodeURIComponent(new URL(url).pathname)
      if (pathname.includes('/git/trees/')) {
        const root = pathname.endsWith('/' + 'f'.repeat(40))
        return githubJson({
          truncated: false,
          tree: [
            {
              path: root ? '.sec-review' : 'setup.yml',
              type: root ? parentType : fileType,
              mode: root ? parentMode : fileMode,
              sha: '1'.repeat(40)
            }
          ]
        })
      }
      return githubFile('setup:\n  - run: echo hi\n', '.sec-review/setup.yml')
    })
    assert.strictEqual(
      await readSetupDeclaration({
        octokit,
        default_sha: 'f'.repeat(40),
        owner_login: 'octo',
        repo_name: 'demo'
      }),
      null
    )
    assert.ok(requests.every(({ url }) => !url.includes('/contents/')))
  })
}

test('readSetupDeclaration returns null when the setup directory exists without a declaration', async () => {
  assert.strictEqual(
    await readSetupDeclaration({
      octokit: octokitForContent({ '.sec-review/other.yml': 'x' }),
      default_sha: 'a'.repeat(40),
      owner_login: 'octo',
      repo_name: 'demo'
    }),
    null
  )
})

for (const failingPath of [
  '/git/trees/' + '1'.repeat(40),
  '/contents/.sec-review/setup.yml'
]) {
  test(`readSetupDeclaration propagates a read failure at ${failingPath}`, async () => {
    const octokit = fakeGitHub(({ url }) => {
      const pathname = decodeURIComponent(new URL(url).pathname)
      if (pathname.endsWith(failingPath))
        return githubJson({ message: 'Forbidden' }, 403)
      const root = pathname.endsWith('/' + 'a'.repeat(40))
      return githubJson({
        truncated: false,
        tree: [
          {
            path: root ? '.sec-review' : 'setup.yml',
            type: root ? 'tree' : 'blob',
            mode: root ? '040000' : '100644',
            sha: '1'.repeat(40)
          }
        ]
      })
    }).octokit
    await assert.rejects(
      readSetupDeclaration({
        octokit,
        default_sha: 'a'.repeat(40),
        owner_login: 'octo',
        repo_name: 'demo'
      }),
      /Forbidden/
    )
  })
}

test('readSetupDeclaration fails on a truncated tree instead of assuming absence', async () => {
  const octokit = fakeGitHub(() =>
    githubJson({ tree: [], truncated: true })
  ).octokit
  await assert.rejects(
    readSetupDeclaration({
      octokit,
      default_sha: 'f'.repeat(40),
      owner_login: 'octo',
      repo_name: 'demo'
    }),
    /truncated/i
  )
})

test('readSetupDeclaration accepts executable files and checks trees at pinned SHAs', async () => {
  const sha = 'a'.repeat(40)
  const subtree = 'b'.repeat(40)
  const { octokit, requests } = fakeGitHub(({ url }) => {
    const pathname = decodeURIComponent(new URL(url).pathname)
    if (pathname.endsWith(`/git/trees/${sha}`))
      return githubJson({
        truncated: false,
        tree: [
          { path: '.sec-review', type: 'tree', mode: '040000', sha: subtree }
        ]
      })
    if (pathname.endsWith(`/git/trees/${subtree}`))
      return githubJson({
        truncated: false,
        tree: [
          {
            path: 'setup.yml',
            type: 'blob',
            mode: '100755',
            sha: 'c'.repeat(40)
          }
        ]
      })
    if (pathname.endsWith('/contents/.sec-review/setup.yml')) {
      assert.strictEqual(new URL(url).searchParams.get('ref'), sha)
      return githubFile('setup:\n  - run: echo hi\n', '.sec-review/setup.yml')
    }
    throw new Error(`Unexpected GitHub request: ${url}`)
  })
  assert.strictEqual(
    await readSetupDeclaration({
      octokit,
      default_sha: sha,
      owner_login: 'octo',
      repo_name: 'demo'
    }),
    'setup:\n  - run: echo hi\n'
  )
  assert.strictEqual(requests.length, 3)
})

test('assertWorkflowInputFits rejects an input past the contract byte limit', () => {
  // `maxItems` bounds how many entries the scan scope carries, not how large they are: a Git
  // path can be thousands of bytes, so a list that satisfies `maxItems` can still serialize to
  // tens of megabytes. This is the check that catches that, before the input reaches Temporal.
  const long_path = 'a/'.repeat(2000) + 'file.py'
  const oversized = {
    scan_scope: {
      incremental_changed_files: Array.from({ length: 5000 }, () => ({
        path: long_path,
        status: 'renamed',
        previous_path: long_path
      }))
    }
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(oversized), 'utf8') >
      MAX_WORKFLOW_INPUT_BYTES
  )
  assert.throws(
    () => assertWorkflowInputFits(oversized, 'repository review'),
    /exceeds the workflow input limit/
  )
})

test('assertWorkflowInputFits allows an input whose entry count is near the limit', () => {
  const fits = {
    scan_scope: {
      incremental_changed_files: Array.from({ length: 5000 }, (_, index) => ({
        path: `src/module${index}.py`,
        status: 'modified',
        previous_path: null
      }))
    }
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(fits), 'utf8') < MAX_WORKFLOW_INPUT_BYTES
  )
  assertWorkflowInputFits(fits, 'repository review')
})

test('archiveInputBundle reproduces bytes for the same logical tree', async () => {
  const roots = await Promise.all([
    fs.mkdtemp(path.join(os.tmpdir(), 'input-bundle-repeat-a-')),
    fs.mkdtemp(path.join(os.tmpdir(), 'input-bundle-repeat-b-'))
  ])
  const archivePaths: string[] = []
  try {
    for (const [index, root] of roots.entries()) {
      await fs.mkdir(path.join(root, 'history'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'manifest.json'),
        '{"api_version":"v1","workspace":{"snapshot":"workspace.snapshot.tar"},"history":{"path":"history"}}\n',
        'utf8'
      )
      await fs.writeFile(
        path.join(root, 'history', 'review.json'),
        '{"kind":"review"}\n',
        'utf8'
      )
      await fs.writeFile(
        path.join(root, 'workspace.snapshot.tar'),
        'snapshot',
        'utf8'
      )
      const timestamp = new Date(Date.now() - index * 60_000)
      await fs.utimes(path.join(root, 'manifest.json'), timestamp, timestamp)
      await fs.utimes(path.join(root, 'history'), timestamp, timestamp)
    }

    const first = await archiveInputBundle({
      input_bundle_root: roots[0]!,
      include_incremental_window: false
    })
    const second = await archiveInputBundle({
      input_bundle_root: roots[1]!,
      include_incremental_window: false
    })
    archivePaths.push(new URL(first.uri).pathname, new URL(second.uri).pathname)

    assert.strictEqual(first.digest, second.digest)
    assert.strictEqual(first.size_bytes, second.size_bytes)
    assert.deepStrictEqual(
      await fs.readFile(new URL(first.uri)),
      await fs.readFile(new URL(second.uri))
    )
  } finally {
    await Promise.all(
      [...roots, ...archivePaths].map((target) =>
        fs.rm(target, { recursive: true, force: true })
      )
    )
  }
})

test('archiveInputBundleAndBuildInput returns a local intent for the claim owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-intent-'))
  try {
    await fs.mkdir(path.join(root, 'history'))
    await fs.writeFile(path.join(root, 'manifest.json'), '{}')
    await fs.writeFile(path.join(root, 'workspace.snapshot.tar'), 'snapshot')
    const result = await archiveInputBundleAndBuildInput({
      input_bundle_root: root,
      include_incremental_window: false,
      workflow: 'test',
      build_input: (reference) => ({ input_bundle: reference })
    })
    assert.match(result.input.input_bundle.uri, /^file:/)
    assert.deepStrictEqual(result.input.input_bundle, result.input_bundle)
    await assert.rejects(
      archiveInputBundleAndBuildInput({
        input_bundle_root: root,
        include_incremental_window: false,
        workflow: 'test',
        build_input: () => 'x'.repeat(MAX_WORKFLOW_INPUT_BYTES + 1)
      }),
      /exceeds the workflow input limit/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(`${root}.tar.zst`, { force: true })
  }
})
