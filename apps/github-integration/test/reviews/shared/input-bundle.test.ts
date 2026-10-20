import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Octokit } from 'octokit'
import {
  archiveInputBundleAndPublish,
  assertWorkflowInputFits,
  readSetupDeclaration
} from '../../../src/reviews/shared/input-bundle.js'
import { MAX_WORKFLOW_INPUT_BYTES } from '../../../src/runner/input.js'
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

test('archiveInputBundleAndPublish checks the input before publishing', async () => {
  // Publishing first would leave an immutable bundle behind whenever the input that references
  // it turns out to be too large, and nothing would point at it afterwards.
  const order: string[] = []
  const input_bundle_root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'input-bundle-order-')
  )
  try {
    // The archive step needs the files the manifest names to exist.
    await fs.mkdir(path.join(input_bundle_root, 'history'), {
      recursive: true
    })
    await fs.writeFile(
      path.join(input_bundle_root, 'manifest.json'),
      JSON.stringify({ bundled_at: new Date().toISOString() }),
      'utf8'
    )
    await fs.writeFile(
      path.join(input_bundle_root, 'workspace.snapshot.tar'),
      'snapshot',
      'utf8'
    )
    const oversized = 'a/'.repeat(2000) + 'file.py'

    await assert.rejects(
      archiveInputBundleAndPublish<string>({
        input_bundle_root,
        include_incremental_window: false,
        run_id: 'run-order',
        workflow: 'test review',
        build_input: (reference) => {
          order.push('build')
          return JSON.stringify({
            input_bundle: reference,
            files: Array.from({ length: 5000 }, () => oversized)
          })
        },
        publish: async (reference) => {
          order.push('publish')
          // Publication rewrites the URI; returning the reference unchanged would hide whether
          // the input was rebuilt from the published value.
          return {
            ...reference,
            uri: 's3://bucket/run-order/input-bundle.v1.tar.zst'
          }
        }
      }),
      /exceeds the workflow input limit/
    )
    order.push('after')

    assert.deepStrictEqual(order, ['build', 'after'])
  } finally {
    await fs.rm(input_bundle_root, { recursive: true, force: true })
  }
})

test('archiveInputBundleAndPublish submits the published URI, not the local one', async () => {
  // Under the S3 store, publication rewrites `file:` to `s3:`, and a remote worker cannot read a
  // local path. The projection is injected because the real one returns the reference unchanged
  // under the file-backed store, which would make this assertion vacuous.
  const input_bundle_root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'input-bundle-uri-')
  )
  try {
    await fs.mkdir(path.join(input_bundle_root, 'history'), {
      recursive: true
    })
    await fs.writeFile(
      path.join(input_bundle_root, 'manifest.json'),
      '{}',
      'utf8'
    )
    await fs.writeFile(
      path.join(input_bundle_root, 'workspace.snapshot.tar'),
      'snapshot',
      'utf8'
    )
    const published_uri =
      's3://bucket/runs/run-uri/input/input-bundle.v1.tar.zst'
    const received: { published: string[]; built: string[] } = {
      published: [],
      built: []
    }

    const result = await archiveInputBundleAndPublish<{
      input_bundle: { uri: string }
    }>({
      input_bundle_root,
      include_incremental_window: false,
      run_id: 'run-uri',
      workflow: 'test review',
      build_input: (reference) => {
        received.built.push(reference.uri)
        return { input_bundle: reference }
      },
      project_published: (reference) => ({ ...reference, uri: published_uri }),
      publish: async (reference) => {
        received.published.push(reference.uri)
        return { ...reference, uri: published_uri }
      }
    })

    // The publisher uploads the local file...
    assert.deepStrictEqual(received.published.length, 1)
    assert.ok(
      (received.published[0] as string).startsWith('file:'),
      `the publisher received ${received.published[0]}, not a local file reference`
    )
    // ...while the input names the projected object.
    assert.deepStrictEqual(received.built, [published_uri])
    assert.strictEqual(result.input.input_bundle.uri, published_uri)
    assert.strictEqual(result.input_bundle.uri, published_uri)
  } finally {
    await fs.rm(input_bundle_root, { recursive: true, force: true })
  }
})

test('archiveInputBundleAndPublish sizes the input before publishing', async () => {
  // An input rejected after the upload would leave an immutable bundle in object storage with
  // nothing pointing at it.
  const input_bundle_root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'input-bundle-order-')
  )
  try {
    await fs.mkdir(path.join(input_bundle_root, 'history'), {
      recursive: true
    })
    await fs.writeFile(
      path.join(input_bundle_root, 'manifest.json'),
      '{}',
      'utf8'
    )
    await fs.writeFile(
      path.join(input_bundle_root, 'workspace.snapshot.tar'),
      'snapshot',
      'utf8'
    )
    const calls: string[] = []

    await assert.rejects(
      archiveInputBundleAndPublish<string>({
        input_bundle_root,
        include_incremental_window: false,
        run_id: 'run-order',
        workflow: 'test review',
        build_input: () => {
          calls.push('build')
          return 'x'.repeat(MAX_WORKFLOW_INPUT_BYTES + 1)
        },
        publish: async (reference) => {
          calls.push('publish')
          return reference
        }
      }),
      /exceeds the workflow input limit/
    )

    assert.deepStrictEqual(calls, ['build'])
  } finally {
    await fs.rm(input_bundle_root, { recursive: true, force: true })
  }
})
