import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRepositoryDeliveryBranchName,
  createRepositoryDeliveryDraftPr as createRepositoryDeliveryDraftPrWithClaim
} from '../../../src/reviews/repositories/delivery-draft-pr.js'
import type { RepositoryDelivery } from '../../../src/reviews/repositories/result.js'
import { PublicationClaimLostError } from '../../../src/control-plane/publication-claim.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

test('repository delivery branch identity includes both run and delivery', () => {
  const delivery = { delivery_id: 'case/shared' } as RepositoryDelivery
  const first = buildRepositoryDeliveryBranchName('run/one', delivery)
  const second = buildRepositoryDeliveryBranchName('run/two', delivery)

  assert.notStrictEqual(first, second)
  assert.match(
    first,
    /^sec-review-bot\/repo-scan\/run-one-[a-f0-9]{12}\/case-shared-[a-f0-9]{12}$/
  )
})
import type { FileMode } from '../../../src/reviews/file-change.js'

type CreateRepositoryDeliveryDraftPrParams = Parameters<
  typeof createRepositoryDeliveryDraftPrWithClaim
>[0]
type CreateRepositoryDeliveryDraftPrRepo =
  CreateRepositoryDeliveryDraftPrParams['repo']
type CreateRepositoryDeliveryDraftPrInput =
  CreateRepositoryDeliveryDraftPrParams['input']

async function createRepositoryDeliveryDraftPr(
  args: Omit<CreateRepositoryDeliveryDraftPrParams, 'assert_publication_claim'>
): ReturnType<typeof createRepositoryDeliveryDraftPrWithClaim> {
  return await createRepositoryDeliveryDraftPrWithClaim({
    ...args,
    assert_publication_claim: async () => {}
  })
}

/**
 * A real GitHub client whose transport answers the git/pulls endpoints the delivery draft-PR
 * path uses, recording what would actually go over the wire.
 */
function createOctokitMock({
  existingPullRequests = [],
  lostPullResponse = false,
  createRefMessage,
  existingCommitTreeSha = 'tree-sha'
}: {
  existingPullRequests?: Array<{
    title: string
    body: string | null
    html_url: string
    number: number
  }>
  /** Create the PR, then lose the response: the retry must recognise the existing PR. */
  lostPullResponse?: boolean
  /** Answer `git.createRef` with this 422 payload message (a duplicate or invalid ref). */
  createRefMessage?: string
  /** Tree sha the already-existing branch commit points at. */
  existingCommitTreeSha?: string
} = {}) {
  const calls = {
    blobs: [] as Array<{ content: string; encoding: 'utf-8' | 'base64' }>,
    trees: [] as Array<
      Array<{ path: string; mode: FileMode; type: 'blob'; sha: string | null }>
    >,
    commits: [] as Array<{ message: string; tree: string; parents: string[] }>,
    refs: [] as Array<{ ref: string; sha: string }>,
    pulls: [] as Array<{
      title: string
      head: string
      base: string
      body: string | null
      draft: boolean
    }>
  }

  // The list is mutable so a retry after a lost create response can see the PR that was made.
  const createdPullRequests = [...existingPullRequests]
  const readRefs: string[] = []
  const updatedRefs: string[] = []
  const { octokit } = fakeGitHub(({ method, url, body }) => {
    const pathname = new URL(url).pathname
    const payload = (body ?? {}) as Record<string, unknown>

    if (pathname.endsWith('/git/blobs')) {
      calls.blobs.push({
        content: String(payload.content),
        encoding: payload.encoding as 'utf-8' | 'base64'
      })
      return githubJson({ sha: `blob-${calls.blobs.length}` })
    }
    if (pathname.endsWith('/git/trees')) {
      calls.trees.push(
        (payload.tree ?? []) as Array<{
          path: string
          mode: FileMode
          type: 'blob'
          sha: string | null
        }>
      )
      return githubJson({ sha: 'tree-sha' })
    }
    if (pathname.endsWith('/git/commits')) {
      calls.commits.push({
        message: String(payload.message),
        tree: String(payload.tree),
        parents: (payload.parents ?? []) as string[]
      })
      return githubJson({ sha: 'commit-sha' })
    }
    if (pathname.endsWith('/git/refs')) {
      if (createRefMessage !== undefined)
        return githubJson({ message: createRefMessage }, 422)
      calls.refs.push({
        ref: `refs/${String(payload.ref)}`,
        sha: String(payload.sha)
      })
      return githubJson({})
    }
    const refMatch = /\/git\/ref\/(.+)$/.exec(pathname)
    if (refMatch) {
      const ref = decodeURIComponent(refMatch[1] ?? '')
      if (method === 'GET') {
        readRefs.push(ref)
        return githubJson({ object: { sha: 'existing-commit-sha' } })
      }
      updatedRefs.push(ref)
      return githubJson({})
    }
    if (pathname.includes('/git/commits/')) {
      const sha = decodeURIComponent(pathname.split('/git/commits/')[1] ?? '')
      return githubJson(
        sha === 'existing-commit-sha'
          ? {
              tree: { sha: existingCommitTreeSha },
              parents: [{ sha: 'base-sha' }]
            }
          : { tree: { sha: 'base-tree-sha' } }
      )
    }
    if (pathname.endsWith('/pulls') && method === 'GET')
      return githubJson(createdPullRequests)
    if (pathname.endsWith('/pulls') && method === 'POST') {
      if (lostPullResponse) {
        createdPullRequests.push({
          title: String(payload.title),
          body: (payload.body ?? null) as string | null,
          html_url: 'https://example.test/pull/lost-response',
          number: 42
        })
        return githubJson({ message: 'lost response after creation' }, 502)
      }
      calls.pulls.push({
        title: String(payload.title),
        head: String(payload.head),
        base: String(payload.base),
        body: (payload.body ?? null) as string | null,
        draft: Boolean(payload.draft)
      })
      return githubJson({ html_url: 'https://example.test/pull/1', number: 1 })
    }
    return githubJson({ default_branch: 'main' })
  })

  return { octokit, calls, readRefs, updatedRefs }
}

test('delivery-draft-pr publishes deleted entries without reading workspace', async () => {
  const { octokit, calls } = createOctokitMock()
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
    octokit,
    repo,
    run_id: 'run-delete',
    input,
    delivery
  })

  assert.strictEqual(result.reused, false)
  assert.strictEqual(calls.blobs.length, 1)
  assert.strictEqual(calls.trees.length, 1)
  assert.deepStrictEqual(calls.trees[0], [
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
  assert.strictEqual(calls.commits.length, 1)
  assert.strictEqual(calls.refs.length, 1)
  assert.strictEqual(calls.pulls.length, 1)
})

test('delivery-draft-pr stops before the next GitHub write after claim loss', async () => {
  const { octokit, calls } = createOctokitMock()
  let ownershipChecks = 0

  await assert.rejects(
    createRepositoryDeliveryDraftPrWithClaim({
      octokit,
      repo: {
        owner_login: 'octo-org',
        repo_name: 'example-repo',
        default_branch: 'main'
      },
      run_id: 'run-claim-loss',
      input: { workspace_ref: 'base-sha' },
      delivery: {
        delivery_id: 'delivery-1',
        case_ids: ['case-1'],
        case_count: 1,
        file_changes: [
          {
            path: 'src/app.txt',
            status: 'upsert',
            content: 'fixed\n',
            content_encoding: 'utf-8'
          }
        ]
      },
      assert_publication_claim: async () => {
        ownershipChecks += 1
        if (ownershipChecks === 2)
          throw new PublicationClaimLostError('run-claim-loss')
      }
    }),
    PublicationClaimLostError
  )

  assert.strictEqual(calls.blobs.length, 1)
  assert.strictEqual(calls.trees.length, 0)
  assert.strictEqual(calls.commits.length, 0)
  assert.strictEqual(calls.refs.length, 0)
  assert.strictEqual(calls.pulls.length, 0)
})

test('delivery-draft-pr reuses a PR when the create response is lost', async () => {
  // The transport creates the PR and then fails, which is what a dropped connection looks like.
  // The retry must find the PR it already made instead of creating a second one.
  const { octokit, calls } = createOctokitMock({ lostPullResponse: true })
  const args = {
    octokit,
    repo: {
      owner_login: 'octo-org',
      repo_name: 'example-repo',
      default_branch: 'main'
    },
    run_id: 'run-lost-pr-response',
    input: { workspace_ref: 'base-sha' },
    delivery: {
      delivery_id: 'delivery-lost-response',
      case_ids: ['case-1'],
      case_count: 1,
      file_changes: [
        {
          path: 'src/app.txt',
          status: 'upsert',
          content: 'fixed\n',
          content_encoding: 'utf-8'
        }
      ]
    } satisfies RepositoryDelivery
  }

  await assert.rejects(createRepositoryDeliveryDraftPr(args))
  const retry = await createRepositoryDeliveryDraftPr(args)
  assert.strictEqual(retry.reused, true)
  assert.strictEqual(retry.number, 42)
  assert.deepStrictEqual(calls.pulls, [], 'no second PR may be created')
})

test('delivery-draft-pr uses scan target branch as PR base when provided', async () => {
  const { octokit, calls } = createOctokitMock()
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
    octokit,
    repo,
    run_id: 'run-target-branch',
    input,
    delivery
  })

  assert.strictEqual(calls.pulls.length, 1)
  assert.strictEqual(calls.pulls[0]?.base, 'release/2026-q2')
})

test('delivery-draft-pr rejects unsafe file paths before publishing git objects', async () => {
  const { octokit, calls } = createOctokitMock()
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
      octokit,
      repo,
      run_id: 'run-unsafe-path',
      input,
      delivery
    }),
    /Sensitive repository file path/
  )

  assert.strictEqual(calls.blobs.length, 0)
  assert.strictEqual(calls.trees.length, 0)
  assert.strictEqual(calls.commits.length, 0)
  assert.strictEqual(calls.refs.length, 0)
  assert.strictEqual(calls.pulls.length, 0)
})

test('delivery-draft-pr rejects unsafe file paths before reusing an existing PR', async () => {
  const { octokit, calls } = createOctokitMock({
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
      octokit,
      repo,
      run_id: 'run-unsafe-existing-pr',
      input,
      delivery
    }),
    /Sensitive repository file path/
  )

  assert.strictEqual(calls.blobs.length, 0)
  assert.strictEqual(calls.trees.length, 0)
  assert.strictEqual(calls.commits.length, 0)
  assert.strictEqual(calls.refs.length, 0)
  assert.strictEqual(calls.pulls.length, 0)
})

function minimalDelivery(deliveryId: string): RepositoryDelivery {
  return {
    delivery_id: deliveryId,
    case_ids: ['case-1'],
    case_count: 1,
    file_changes: [
      {
        path: 'src/app.txt',
        status: 'upsert',
        content: 'fixed\n',
        content_encoding: 'utf-8'
      }
    ]
  }
}

test('delivery-draft-pr reads an existing ref without force-updating it', async () => {
  const { octokit, readRefs, updatedRefs } = createOctokitMock({
    createRefMessage: 'Reference already exists'
  })

  await createRepositoryDeliveryDraftPr({
    octokit,
    repo: {
      owner_login: 'octo-org',
      repo_name: 'example-repo',
      default_branch: 'main'
    },
    run_id: 'run-ref-exists',
    input: { workspace_ref: 'base-sha' },
    delivery: minimalDelivery('delivery-ref-exists')
  })

  assert.strictEqual(readRefs.length, 1)
  assert.deepStrictEqual(updatedRefs, [])
})

test('delivery-draft-pr does not create a PR from an existing branch with a different tree', async () => {
  const { octokit, calls } = createOctokitMock({
    createRefMessage: 'Reference already exists',
    existingCommitTreeSha: 'different-tree-sha'
  })

  await assert.rejects(
    createRepositoryDeliveryDraftPr({
      octokit,
      repo: {
        owner_login: 'octo-org',
        repo_name: 'example-repo',
        default_branch: 'main'
      },
      run_id: 'run-ref-exists',
      input: { workspace_ref: 'base-sha' },
      delivery: minimalDelivery('delivery-ref-exists')
    }),
    /Existing delivery draft PR branch does not match/
  )
  assert.strictEqual(calls.pulls.length, 0)
})

test('delivery-draft-pr does not force-update a createRef 422 that is not "already exists"', async () => {
  const { octokit, updatedRefs } = createOctokitMock({
    createRefMessage: 'Reference name is invalid'
  })

  await assert.rejects(
    createRepositoryDeliveryDraftPr({
      octokit,
      repo: {
        owner_login: 'octo-org',
        repo_name: 'example-repo',
        default_branch: 'main'
      },
      run_id: 'run-invalid-ref',
      input: { workspace_ref: 'base-sha' },
      delivery: minimalDelivery('delivery-invalid-ref')
    }),
    (error: unknown) => (error as { status?: unknown }).status === 422
  )

  assert.deepStrictEqual(updatedRefs, [])
})
