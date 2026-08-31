import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraftPullRequestFromIssueReviewRecord } from '../../../reviews/issues/draft-pr.js'
import type { ReviewRecord } from '../../../reviews/review-record.js'
import type { FileMode } from '../../../reviews/file-change.js'

type CreateDraftPrParams = Parameters<typeof createDraftPullRequestFromIssueReviewRecord>[0]
type CreateDraftPrOctokit = CreateDraftPrParams['octokit']
type CreateDraftPrIssue = CreateDraftPrParams['issue']
type TestMitigation = Omit<Partial<ReviewRecord['mitigation']>, 'file_changes'> & {
  file_changes?: unknown[]
}

function reviewRecordWithMitigation (mitigation: TestMitigation): ReviewRecord {
  return {
    analysis: {
      verdict: null,
      overview: null,
      narratives: []
    },
    mitigation: {
      overview: null,
      changed_files: [],
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

function createOctokitMock () {
  const calls = {
    blobs: [] as Array<{ content: string, encoding: 'utf-8' | 'base64' }>,
    trees: [] as Array<Array<{ path: string, mode: FileMode, type: 'blob', sha: string | null }>>,
    commits: [] as Array<{ message: string, tree: string, parents: string[] }>,
    refs: [] as Array<{ ref: string, sha: string }>,
    pulls: [] as Array<{ title: string, head: string, base: string, body: string, draft: boolean }>
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
        }
      },
      pulls: {
        create: async ({ title, head, base, body, draft }: { title: string, head: string, base: string, body: string, draft: boolean }) => {
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

test('issue draft PR publishes from review_record file_changes without workspace reads', async () => {
  const octokit = createOctokitMock()
  const issue: CreateDraftPrIssue = {
    issue_number: 42,
    issue_title: 'Fix unsafe path',
    owner_login: 'octo-org',
    repo_name: 'example-repo',
    default_branch: 'main'
  }
  const review_record = reviewRecordWithMitigation({
    changed_files: ['src/app.txt', 'src/remove.txt'],
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
    octokit: octokit as unknown as CreateDraftPrOctokit,
    issue,
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record
  })

  assert.equal(result?.html_url, 'https://example.test/pull/1')
  assert.deepEqual(octokit.calls.blobs, [
    {
      content: 'fixed\n',
      encoding: 'utf-8'
    }
  ])
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
  assert.deepEqual(octokit.calls.commits, [
    {
      message: 'Mitigate issue #42',
      tree: 'tree-sha',
      parents: ['base-sha']
    }
  ])
  assert.equal(octokit.calls.pulls[0]?.draft, true)
  assert.match(octokit.calls.pulls[0]?.body ?? '', /\*\*Regression Status:\*\* `not-run`/)
  assert.match(octokit.calls.pulls[0]?.body ?? '', /sec-review-bot-regression-status: not-run/)
})

test('issue draft PR is not promoted when file_changes are absent', async () => {
  const octokit = createOctokitMock()
  const result = await createDraftPullRequestFromIssueReviewRecord({
    octokit: octokit as unknown as CreateDraftPrOctokit,
    issue: {
      issue_number: 42,
      owner_login: 'octo-org',
      repo_name: 'example-repo',
      default_branch: 'main'
    },
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record: reviewRecordWithMitigation({
      changed_files: ['src/app.txt']
    })
  })

  assert.equal(result, null)
  assert.equal(octokit.calls.blobs.length, 0)
  assert.equal(octokit.calls.trees.length, 0)
})

test('issue draft PR ignores unsafe display changed_files when file_changes are safe', async () => {
  const octokit = createOctokitMock()
  const issue: CreateDraftPrIssue = {
    issue_number: 42,
    issue_title: 'Fix unsafe path',
    owner_login: 'octo-org',
    repo_name: 'example-repo',
    default_branch: 'main'
  }
  const review_record = reviewRecordWithMitigation({
    changed_files: ['workspace/../notes', '.github/workflows/pwn.yml', 'src/app.txt'],
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
    octokit: octokit as unknown as CreateDraftPrOctokit,
    issue,
    run_id: 'run-12345678',
    workspace_ref: 'base-sha',
    review_record
  })

  assert.equal(result?.html_url, 'https://example.test/pull/1')
  assert.deepEqual(octokit.calls.trees[0], [
    {
      path: 'src/app.txt',
      mode: '100644',
      type: 'blob',
      sha: 'blob-1'
    }
  ])
})

test('issue draft PR rejects unsupported file modes', async () => {
  const octokit = createOctokitMock()
  const review_record = reviewRecordWithMitigation({
    changed_files: ['src/app.txt'],
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
    async () => createDraftPullRequestFromIssueReviewRecord({
      octokit: octokit as unknown as CreateDraftPrOctokit,
      issue: {
        issue_number: 42,
        owner_login: 'octo-org',
        repo_name: 'example-repo',
        default_branch: 'main'
      },
      run_id: 'run-12345678',
      workspace_ref: 'base-sha',
      review_record
    }),
    /unsupported file mode/
  )
  assert.equal(octokit.calls.blobs.length, 0)
  assert.equal(octokit.calls.trees.length, 0)
})

test('issue draft PR rejects deleted file changes with mode', async () => {
  const octokit = createOctokitMock()
  const review_record = reviewRecordWithMitigation({
    changed_files: ['src/remove.txt'],
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
    async () => createDraftPullRequestFromIssueReviewRecord({
      octokit: octokit as unknown as CreateDraftPrOctokit,
      issue: {
        issue_number: 42,
        owner_login: 'octo-org',
        repo_name: 'example-repo',
        default_branch: 'main'
      },
      run_id: 'run-12345678',
      workspace_ref: 'base-sha',
      review_record
    }),
    /deleted but also included a mode/
  )
  assert.equal(octokit.calls.blobs.length, 0)
  assert.equal(octokit.calls.trees.length, 0)
})

for (const [path, message] of [
  ['workspace/../x', /Unsafe repository file path/],
  ['.github/workflows/pwn.yml', /Sensitive repository file path/]
] as const) {
  test(`issue draft PR rejects unsafe repository path ${path}`, async () => {
    const octokit = createOctokitMock()
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
      async () => createDraftPullRequestFromIssueReviewRecord({
        octokit: octokit as unknown as CreateDraftPrOctokit,
        issue: {
          issue_number: 42,
          owner_login: 'octo-org',
          repo_name: 'example-repo',
          default_branch: 'main'
        },
        run_id: 'run-12345678',
        workspace_ref: 'base-sha',
        review_record
      }),
      message
    )
    assert.equal(octokit.calls.blobs.length, 0)
    assert.equal(octokit.calls.trees.length, 0)
  })
}
