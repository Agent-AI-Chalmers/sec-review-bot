import assert from 'node:assert/strict'
import test from 'node:test'

import { createRepositoryDeliveryDraftPr } from '../../../reviews/repositories/delivery-draft-pr.js'
import type { RepositoryDelivery } from '../../../reviews/repositories/result.js'
import type { FileMode } from '../../../reviews/file-change.js'

type CreateRepositoryDeliveryDraftPrParams = Parameters<typeof createRepositoryDeliveryDraftPr>[0]
type CreateRepositoryDeliveryDraftPrOctokit = CreateRepositoryDeliveryDraftPrParams['octokit']
type CreateRepositoryDeliveryDraftPrRepo = CreateRepositoryDeliveryDraftPrParams['repo']
type CreateRepositoryDeliveryDraftPrInput = CreateRepositoryDeliveryDraftPrParams['input']

function createOctokitMock ({
  existingPullRequests = []
}: {
  existingPullRequests?: Array<{
    title: string
    body: string | null
    html_url: string
    number: number
  }>
} = {}) {
  const calls = {
    blobs: [] as Array<{ content: string, encoding: 'utf-8' | 'base64' }>,
    trees: [] as Array<Array<{ path: string, mode: FileMode, type: 'blob', sha: string | null }>>,
    commits: [] as Array<{ message: string, tree: string, parents: string[] }>,
    refs: [] as Array<{ ref: string, sha: string }>,
    pulls: [] as Array<{ title: string, head: string, base: string, body: string | null, draft: boolean }>
  }

  return {
    calls,
    rest: {
      git: {
        createBlob: async ({ content, encoding }: { content: string, encoding: 'utf-8' | 'base64' }) => {
          calls.blobs.push({ content, encoding })
          return { data: { sha: `blob-${calls.blobs.length}` } }
        },
        getCommit: async () => ({ data: { tree: { sha: 'base-tree-sha' } } }),
        createTree: async ({ tree }: { tree: Array<{ path: string, mode: FileMode, type: 'blob', sha: string | null }> }) => {
          calls.trees.push(tree)
          return { data: { sha: 'tree-sha' } }
        },
        createCommit: async ({ message, tree, parents }: { message: string, tree: string, parents: string[] }) => {
          calls.commits.push({ message, tree, parents })
          return { data: { sha: 'commit-sha' } }
        },
        createRef: async ({ ref, sha }: { ref: string, sha: string }) => {
          calls.refs.push({ ref, sha })
          return { data: {} }
        },
        updateRef: async () => ({ data: {} })
      },
      pulls: {
        list: async () => ({ data: existingPullRequests }),
        create: async ({ title, head, base, body, draft }: { title: string, head: string, base: string, body: string | null, draft: boolean }) => {
          calls.pulls.push({ title, head, base, body, draft })
          return {
            data: {
              html_url: 'https://example.test/pull/1',
              number: 1
            }
          }
        }
      }
    }
  }
}

test('delivery-draft-pr publishes deleted entries without reading workspace', async () => {
  const octokit = createOctokitMock()
  const repo: CreateRepositoryDeliveryDraftPrRepo = {
    owner_login: 'octo-org',
    repo_name: 'example-repo',
    default_branch: 'main'
  }
  const input: CreateRepositoryDeliveryDraftPrInput = {
    workspace_ref: 'base-sha'
  }
  const delivery: RepositoryDelivery = {
    delivery_id: 'delivery-1',
    case_ids: ['case-1'],
    case_count: 1,
    file_changes: [
      {
        path: 'src/app.txt',
        status: 'upsert',
        content: 'alpha updated\n',
        content_encoding: 'utf-8',
        mode: '100755'
      },
      {
        path: 'src/remove.txt',
        status: 'deleted'
      }
    ]
  }

  const result = await createRepositoryDeliveryDraftPr({
    octokit: octokit as unknown as CreateRepositoryDeliveryDraftPrOctokit,
    repo,
    input,
    delivery
  })

  assert.equal(result.reused, false)
  assert.equal(octokit.calls.blobs.length, 1)
  assert.equal(octokit.calls.trees.length, 1)
  assert.deepEqual(octokit.calls.trees[0], [
    {
      path: 'src/app.txt',
      mode: '100755',
      type: 'blob',
      sha: 'blob-1'
    },
    {
      path: 'src/remove.txt',
      mode: '100644',
      type: 'blob',
      sha: null
    }
  ])
  assert.equal(octokit.calls.commits.length, 1)
  assert.equal(octokit.calls.refs.length, 1)
  assert.equal(octokit.calls.pulls.length, 1)
})

test('delivery-draft-pr uses scan target branch as PR base when provided', async () => {
  const octokit = createOctokitMock()
  const repo: CreateRepositoryDeliveryDraftPrRepo = {
    owner_login: 'octo-org',
    repo_name: 'example-repo',
    default_branch: 'main'
  }
  const input: CreateRepositoryDeliveryDraftPrInput = {
    workspace_ref: 'base-sha',
    scan_target: {
      target_branch: 'release/2026-q2'
    }
  }
  const delivery: RepositoryDelivery = {
    delivery_id: 'delivery-branch-base',
    case_ids: ['case-1'],
    case_count: 1,
    file_changes: [
      {
        path: 'src/app.txt',
        status: 'upsert',
        content: 'alpha updated\n',
        content_encoding: 'utf-8'
      }
    ]
  }

  await createRepositoryDeliveryDraftPr({
    octokit: octokit as unknown as CreateRepositoryDeliveryDraftPrOctokit,
    repo,
    input,
    delivery
  })

  assert.equal(octokit.calls.pulls.length, 1)
  assert.equal(octokit.calls.pulls[0]?.base, 'release/2026-q2')
})

test('delivery-draft-pr rejects unsafe file paths before publishing git objects', async () => {
  const octokit = createOctokitMock()
  const repo: CreateRepositoryDeliveryDraftPrRepo = {
    owner_login: 'octo-org',
    repo_name: 'example-repo',
    default_branch: 'main'
  }
  const input: CreateRepositoryDeliveryDraftPrInput = {
    workspace_ref: 'base-sha'
  }
  const delivery: RepositoryDelivery = {
    delivery_id: 'delivery-unsafe-path',
    case_ids: ['case-1'],
    case_count: 1,
    file_changes: [
      {
        path: '.github/workflows/pwn.yml',
        status: 'upsert',
        content: 'name: pwn\n',
        content_encoding: 'utf-8'
      }
    ]
  }

  await assert.rejects(
    createRepositoryDeliveryDraftPr({
      octokit: octokit as unknown as CreateRepositoryDeliveryDraftPrOctokit,
      repo,
      input,
      delivery
    }),
    /Sensitive repository file path/
  )

  assert.equal(octokit.calls.blobs.length, 0)
  assert.equal(octokit.calls.trees.length, 0)
  assert.equal(octokit.calls.commits.length, 0)
  assert.equal(octokit.calls.refs.length, 0)
  assert.equal(octokit.calls.pulls.length, 0)
})

test('delivery-draft-pr rejects unsafe file paths before reusing an existing PR', async () => {
  const octokit = createOctokitMock({
    existingPullRequests: [
      {
        title: 'Existing delivery',
        body: null,
        html_url: 'https://example.test/pull/9',
        number: 9
      }
    ]
  })
  const repo: CreateRepositoryDeliveryDraftPrRepo = {
    owner_login: 'octo-org',
    repo_name: 'example-repo',
    default_branch: 'main'
  }
  const input: CreateRepositoryDeliveryDraftPrInput = {
    workspace_ref: 'base-sha'
  }
  const delivery: RepositoryDelivery = {
    delivery_id: 'delivery-unsafe-existing-pr',
    case_ids: ['case-1'],
    case_count: 1,
    file_changes: [
      {
        path: '.github/workflows/pwn.yml',
        status: 'upsert',
        content: 'name: pwn\n',
        content_encoding: 'utf-8'
      }
    ]
  }

  await assert.rejects(
    createRepositoryDeliveryDraftPr({
      octokit: octokit as unknown as CreateRepositoryDeliveryDraftPrOctokit,
      repo,
      input,
      delivery
    }),
    /Sensitive repository file path/
  )

  assert.equal(octokit.calls.blobs.length, 0)
  assert.equal(octokit.calls.trees.length, 0)
  assert.equal(octokit.calls.commits.length, 0)
  assert.equal(octokit.calls.refs.length, 0)
  assert.equal(octokit.calls.pulls.length, 0)
})
