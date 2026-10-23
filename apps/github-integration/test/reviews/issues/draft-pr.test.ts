import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDraftBranchName,
  createDraftPullRequestFromIssueReviewRecord as createDraftPullRequestWithClaim
} from '../../../src/reviews/issues/draft-pr.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'
import type { FileMode } from '../../../src/reviews/file-change.js'
import { PublicationClaimLostError } from '../../../src/control-plane/publication-claim.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

type CreateDraftPrParams = Parameters<typeof createDraftPullRequestWithClaim>[0]
type CreateDraftPrIssue = CreateDraftPrParams['issue']
type TestMitigation = Omit<
  Partial<ReviewRecord['mitigation']>,
  'file_changes'
> & {
  file_changes?: unknown[]
}

async function createDraftPullRequestFromIssueReviewRecord(
  args: Omit<CreateDraftPrParams, 'assert_publication_claim'>
): ReturnType<typeof createDraftPullRequestWithClaim> {
  return await createDraftPullRequestWithClaim({
    ...args,
    assert_publication_claim: async () => {}
  })
}

function reviewRecordWithMitigation(mitigation: TestMitigation): ReviewRecord {
  return {
    analysis: {
      verdict: null,
      overview: null,
      narratives: []
    },
    mitigation: {
      overview: null,
      file_changes: [],
      patch_diff: null,
      ...mitigation
    },
    verification: {
      overview: null,
      review_target_claim: null,
      validation_level: null,
      patch_coverage: null,
      regression_status: null,
      resolution_next_step: null,
      patch_findings: [],
      verification_findings: [],
      residual_risks: []
    },
    cvss: null
  } as ReviewRecord
}

/**
 * A real GitHub client whose transport answers the git/pulls endpoints the issue draft-PR path
 * uses, recording the same call shapes the assertions below read.
 *
 * Running the real client means the request bodies are built by the SDK, so each recorded call is
 * what would actually go over the wire rather than what a hand-written mock was told to return.
 */
function createOctokitMock({
  existingPullRequests = [],
  branchAlreadyExists = false,
  existingCommitTreeSha = 'tree-sha'
}: {
  existingPullRequests?: Array<{
    title: string
    body: string | null
    html_url: string
    number: number
  }>
  /** Answer `git.createRef` with the real 422 "Reference already exists". */
  branchAlreadyExists?: boolean
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
    readRefs: [] as string[],
    updatedRefs: [] as Array<{ ref: string; sha: string; force: boolean }>,
    pulls: [] as Array<{
      title: string
      head: string
      base: string
      body: string
      draft: boolean
    }>
  }

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
    // `git.getRef`/`git.updateRef` use `/git/ref/{ref}` (singular); `git.createRef` uses
    // `/git/refs`. The ref segment is percent-encoded, so it is decoded before recording.
    const refMatch = /\/git\/ref\/(.+)$/.exec(pathname)
    if (refMatch) {
      const ref = decodeURIComponent(refMatch[1] ?? '')
      if (method === 'GET') {
        calls.readRefs.push(ref)
        return githubJson({ object: { sha: 'existing-commit-sha' } })
      }
      calls.updatedRefs.push({
        ref,
        sha: String(payload.sha),
        force: Boolean(payload.force)
      })
      return githubJson({})
    }
    if (pathname.endsWith('/git/refs')) {
      calls.refs.push({
        ref: `refs/${String(payload.ref)}`,
        sha: String(payload.sha)
      })
      // A 422 "Reference already exists" is what GitHub answers for a duplicate branch.
      // A real duplicate-ref reply: `isBranchAlreadyExists` reads `response.data.message`.
      if (branchAlreadyExists)
        return githubJson({ message: 'Reference already exists' }, 422)
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
      return githubJson(existingPullRequests)
    if (pathname.endsWith('/pulls') && method === 'POST') {
      calls.pulls.push({
        title: String(payload.title),
        head: String(payload.head),
        base: String(payload.base),
        body: String(payload.body ?? ''),
        draft: Boolean(payload.draft)
      })
      return githubJson({ html_url: 'https://example.test/pull/1', number: 1 })
    }
    if (pathname.includes('/branches/')) {
      return githubJson({ commit: { sha: 'resolved-default-sha' } })
    }
    return githubJson({ default_branch: 'main' })
  })

  return { octokit, calls }
}

test('issue draft PR reuses an existing run branch PR without creating git objects', async () => {
  const { octokit, calls: harness } = createOctokitMock({
    existingPullRequests: [
      {
        title: 'Existing fix',
        body: 'Existing body',
        html_url: 'https://example.test/pull/9',
        number: 9
      }
    ]
  })
  const result = await createDraftPullRequestFromIssueReviewRecord({
    octokit,
    issue: {
      issue_number: 42,
      owner_login: 'octo-org',
      repo_name: 'example-repo'
    },
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record: reviewRecordWithMitigation({
      file_changes: [
        {
          path: 'src/app.txt',
          status: 'upsert',
          content: 'fixed\n',
          content_encoding: 'utf-8'
        }
      ]
    })
  })

  assert.strictEqual(result?.number, 9)
  assert.strictEqual(harness.blobs.length, 0)
  assert.strictEqual(harness.commits.length, 0)
})

test('issue draft PR retry reuses a branch left by a partial prior attempt without overwriting it', async () => {
  const { octokit, calls: harness } = createOctokitMock({
    branchAlreadyExists: true
  })
  const review_record = reviewRecordWithMitigation({
    file_changes: [
      {
        path: 'src/app.txt',
        status: 'upsert',
        content: 'fixed\n',
        content_encoding: 'utf-8'
      }
    ]
  })
  review_record.verification.patch_coverage = 'full'

  const result = await createDraftPullRequestFromIssueReviewRecord({
    octokit,
    issue: {
      issue_number: 42,
      owner_login: 'octo-org',
      repo_name: 'example-repo'
    },
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record
  })

  assert.strictEqual(result?.number, 1)
  // The whole run id names the branch. A shorter segment (the last 8 characters) is what two
  // runs can share, and this branch is the publication's idempotency key.
  assert.deepStrictEqual(harness.readRefs, [
    'heads/sec-review-bot/issue-42-run-12345678'
  ])
  assert.deepStrictEqual(harness.updatedRefs, [])
})

test('two runs of the same issue never share a draft branch', () => {
  // The branch is verified and reused on a retry, so a shared name makes one run adopt the
  // other's branch. Run ids that agree on their last 8 characters are exactly the case a slice
  // produced, and Control Plane hands out enough of them for that to happen in a busy deployment.
  const issue = {
    issue_number: 42,
    owner_login: 'octo-org',
    repo_name: 'example'
  }
  const first = buildDraftBranchName(
    issue,
    'aaaaaaaa-1111-4111-8111-00000000c0de'
  )
  const second = buildDraftBranchName(
    issue,
    'bbbbbbbb-2222-4222-8222-00000000c0de'
  )
  assert.notStrictEqual(first, second)
  assert.notStrictEqual(
    buildDraftBranchName(issue, undefined),
    buildDraftBranchName(issue, 'aaaaaaaa-1111-4111-8111-00000000c0de')
  )
})

test('issue draft PR does not create a PR from an existing branch with a different tree', async () => {
  // The existing branch commit has different contents from this run's tree, so recovery must
  // refuse to reuse it.
  const { octokit, calls: harness } = createOctokitMock({
    branchAlreadyExists: true,
    existingCommitTreeSha: 'different-tree-sha'
  })

  await assert.rejects(
    createDraftPullRequestFromIssueReviewRecord({
      octokit,
      issue: {
        issue_number: 42,
        owner_login: 'octo-org',
        repo_name: 'example-repo'
      },
      run_id: 'run-12345678',
      workspace_ref: 'base-sha',
      review_record: reviewRecordWithMitigation({
        file_changes: [
          {
            path: 'src/app.txt',
            status: 'upsert',
            content: 'fixed\n',
            content_encoding: 'utf-8'
          }
        ]
      })
    }),
    /Existing draft PR branch does not match/
  )
  assert.strictEqual(harness.pulls.length, 0)
})

test('issue draft PR stops before the next GitHub write after claim loss', async () => {
  const { octokit, calls: harness } = createOctokitMock()
  let ownershipChecks = 0

  await assert.rejects(
    createDraftPullRequestWithClaim({
      octokit,
      issue: {
        issue_number: 42,
        owner_login: 'octo-org',
        repo_name: 'example-repo'
      },
      run_id: 'run-12345678',
      workspace_ref: 'base-sha',
      review_record: reviewRecordWithMitigation({
        file_changes: [
          {
            path: 'src/app.txt',
            status: 'upsert',
            content: 'fixed\n',
            content_encoding: 'utf-8'
          }
        ]
      }),
      assert_publication_claim: async () => {
        ownershipChecks += 1
        if (ownershipChecks === 2)
          throw new PublicationClaimLostError('run-12345678')
      }
    }),
    PublicationClaimLostError
  )

  assert.strictEqual(harness.blobs.length, 1)
  assert.strictEqual(harness.trees.length, 0)
  assert.strictEqual(harness.commits.length, 0)
  assert.strictEqual(harness.refs.length, 0)
  assert.strictEqual(harness.pulls.length, 0)
})

test('issue draft PR publishes from review_record file_changes without workspace reads', async () => {
  const { octokit, calls: harness } = createOctokitMock()
  const issue: CreateDraftPrIssue = {
    issue_number: 42,
    issue_title: 'Fix unsafe path',
    owner_login: 'octo-org',
    repo_name: 'example-repo'
  }
  const review_record = reviewRecordWithMitigation({
    file_changes: [
      {
        path: '/workspace/src/app.txt',
        status: 'upsert',
        content: 'fixed\n',
        content_encoding: 'utf-8',
        mode: '100755'
      },
      {
        path: 'src/remove.txt',
        status: 'deleted'
      }
    ]
  })
  review_record.verification.patch_coverage = 'full'
  review_record.verification.regression_status = 'not-run'
  const result = await createDraftPullRequestFromIssueReviewRecord({
    octokit,
    issue,
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record
  })

  assert.strictEqual(result?.html_url, 'https://example.test/pull/1')
  assert.deepStrictEqual(harness.blobs, [
    {
      content: 'fixed\n',
      encoding: 'utf-8'
    }
  ])
  assert.deepStrictEqual(harness.trees[0], [
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
  assert.deepStrictEqual(harness.commits, [
    {
      message: 'Mitigate issue #42',
      tree: 'tree-sha',
      parents: ['base-sha']
    }
  ])
  assert.strictEqual(harness.pulls[0]?.draft, true)
  // The PR base is the API-resolved default branch, not the webhook payload's
  // repository.default_branch (which the trusted flow refuses elsewhere too).
  assert.strictEqual(harness.pulls[0]?.base, 'main')
  // The opening status lines come from the shared vocabulary, so this body stays
  // comparable with the PR review comment and the repository delivery bodies.
  assert.match(harness.pulls[0]?.body ?? '', /- Analysis: `unknown`/)
  assert.match(
    harness.pulls[0]?.body ?? '',
    /- Verification: `full coverage; not recorded; checks not run`/
  )
  assert.match(harness.pulls[0]?.body ?? '', /Verifier assessed patch=/)
})

test('issue draft PR is not promoted when file_changes are absent', async () => {
  const { octokit, calls: harness } = createOctokitMock()
  const result = await createDraftPullRequestFromIssueReviewRecord({
    octokit,
    issue: {
      issue_number: 42,
      owner_login: 'octo-org',
      repo_name: 'example-repo'
    },
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record: reviewRecordWithMitigation({})
  })

  assert.strictEqual(result, null)
  assert.strictEqual(harness.blobs.length, 0)
  assert.strictEqual(harness.trees.length, 0)
})

test('issue draft PR rejects unsupported file modes', async () => {
  const { octokit, calls: harness } = createOctokitMock()
  const review_record = reviewRecordWithMitigation({
    file_changes: [
      {
        path: 'src/app.txt',
        status: 'upsert',
        content: 'fixed\n',
        content_encoding: 'utf-8',
        mode: '100600'
      }
    ]
  })
  review_record.verification.patch_coverage = 'full'

  await assert.rejects(
    async () =>
      createDraftPullRequestFromIssueReviewRecord({
        octokit,
        issue: {
          issue_number: 42,
          owner_login: 'octo-org',
          repo_name: 'example-repo'
        },
        run_id: 'run-12345678',
        workspace_ref: 'base-sha',
        review_record
      }),
    /unsupported file mode/
  )
  assert.strictEqual(harness.blobs.length, 0)
  assert.strictEqual(harness.trees.length, 0)
})

test('issue draft PR rejects deleted file changes with mode', async () => {
  const { octokit, calls: harness } = createOctokitMock()
  const review_record = reviewRecordWithMitigation({
    file_changes: [
      {
        path: 'src/remove.txt',
        status: 'deleted',
        mode: '100755'
      }
    ]
  })
  review_record.verification.patch_coverage = 'full'

  await assert.rejects(
    async () =>
      createDraftPullRequestFromIssueReviewRecord({
        octokit,
        issue: {
          issue_number: 42,
          owner_login: 'octo-org',
          repo_name: 'example-repo'
        },
        run_id: 'run-12345678',
        workspace_ref: 'base-sha',
        review_record
      }),
    /deleted but also included a mode/
  )
  assert.strictEqual(harness.blobs.length, 0)
  assert.strictEqual(harness.trees.length, 0)
})

for (const [path, message] of [
  ['workspace/../x', /Unsafe repository file path/],
  ['.github/workflows/pwn.yml', /Sensitive repository file path/]
] as const) {
  test(`issue draft PR rejects unsafe repository path ${path}`, async () => {
    const { octokit, calls: harness } = createOctokitMock()
    const review_record = reviewRecordWithMitigation({
      file_changes: [
        {
          path,
          status: 'upsert',
          content: 'name: pwn\n',
          content_encoding: 'utf-8'
        }
      ]
    })
    review_record.verification.patch_coverage = 'full'

    await assert.rejects(
      async () =>
        createDraftPullRequestFromIssueReviewRecord({
          octokit,
          issue: {
            issue_number: 42,
            owner_login: 'octo-org',
            repo_name: 'example-repo'
          },
          run_id: 'run-12345678',
          workspace_ref: 'base-sha',
          review_record
        }),
      message
    )
    assert.strictEqual(harness.blobs.length, 0)
    assert.strictEqual(harness.trees.length, 0)
  })
}
