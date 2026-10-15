import assert from 'node:assert/strict'
import test from 'node:test'

import { handleIssueReviewRun } from '../../../src/reviews/issues/publish.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'
import { CONTRACT_VERSION } from '../../../src/runner/contract-version.js'

function issueReviewRecordWithPatch(): ReviewRecord {
  return {
    analysis: {
      verdict: 'confirmed-vulnerability',
      overview: 'A concrete patch is ready.',
      narratives: []
    },
    mitigation: {
      overview: 'Apply the fix.',
      changed_files: ['src/app.ts'],
      file_changes: [
        {
          path: 'src/app.ts',
          status: 'upsert',
          content: 'export const fixed = true\n',
          content_encoding: 'utf-8'
        }
      ],
      patch_diff: null
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

function buildHarness() {
  const createdPullRequests: unknown[] = []
  const createdComments: unknown[] = []
  const initializedSteps: string[][] = []
  const steps = new Map<string, { step_key: string; status: string }>()

  const store = {
    initializePublicationSteps: async (
      _runId: string,
      _token: string,
      keys: string[]
    ) => {
      initializedSteps.push(keys)
      for (const key of keys)
        steps.set(key, { step_key: key, status: 'pending' })
    },
    listPublicationSteps: async () =>
      Array.from(steps.values()).map((item) => ({
        step_key: item.step_key,
        status: item.status,
        remote_object_id: null,
        remote_object_url: null
      })),
    requirePublicationStepClaim: async () => {},
    completePublicationStep: async () => true,
    failPublicationStep: async () => true
  }

  const octokit = {
    rest: {
      repos: {
        // The draft-PR base is resolved via API, not from the payload/persisted
        // default_branch; keep the mock's resolved value aligned with the fixture.
        get: async () => ({ data: { default_branch: 'main' } }),
        getBranch: async () => ({
          data: { commit: { sha: 'resolved-default-sha' } }
        })
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async (args: unknown) => {
          createdPullRequests.push(args)
          return {
            data: { html_url: 'https://example.test/pull/1', number: 1 }
          }
        }
      },
      git: {
        createBlob: async () => ({ data: { sha: 'blob-sha' } }),
        getCommit: async () => ({ data: { tree: { sha: 'base-tree-sha' } } }),
        createTree: async () => ({ data: { sha: 'tree-sha' } }),
        createCommit: async () => ({ data: { sha: 'commit-sha' } }),
        createRef: async () => ({ data: {} }),
        updateRef: async () => ({ data: {} })
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (args: unknown) => {
          createdComments.push(args)
          return { data: { id: 1, html_url: 'https://example.test/comment/1' } }
        }
      }
    }
  }

  return {
    store,
    octokit,
    createdPullRequests,
    createdComments,
    initializedSteps
  }
}

async function runPublish(open_pr: boolean) {
  const harness = buildHarness()
  await handleIssueReviewRun({
    run: {
      run_id: 'run-1',
      publish_context: {
        issue: {
          owner_login: 'octo',
          repo_name: 'example',
          repo_full_name: 'octo/example',
          default_branch: 'main',
          issue_number: 7,
          issue_title: 'Example issue'
        },
        workspace_ref: 'workspace-sha',
        event_type: 'manual_review',
        open_pr
      }
    },
    result: {
      contract_version: CONTRACT_VERSION,
      review_record: issueReviewRecordWithPatch()
    },
    store: harness.store as never,
    claim_token: 'claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => harness.octokit
  })
  return harness
}

test('issue publish opens a draft PR when the run opted in', async () => {
  const harness = await runPublish(true)
  assert.strictEqual(harness.createdPullRequests.length, 1)
  assert.strictEqual(harness.createdComments.length, 1)
  assert.deepStrictEqual(harness.initializedSteps[0], [
    'issue:draft-pr',
    'issue:summary-comment'
  ])
})

test('issue publish keeps the patch in the summary comment when not opted in', async () => {
  const harness = await runPublish(false)
  assert.strictEqual(harness.createdPullRequests.length, 0)
  assert.strictEqual(harness.createdComments.length, 1)
  assert.deepStrictEqual(harness.initializedSteps[0], ['issue:summary-comment'])
})
