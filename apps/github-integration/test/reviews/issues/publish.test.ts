import assert from 'node:assert/strict'
import test from 'node:test'

import { handleIssueReviewRun } from '../../../src/reviews/issues/publish.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'
import type {
  PublicationStepRecord,
  PublicationStepStore
} from '../../../src/control-plane/client.js'
import { CONTRACT_VERSION } from '../../../src/runner/contract-version.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

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
  // A complete step record: the publisher reads `attempt_count` and `remote_object_id`, so a
  // partial fixture would hand it `undefined` (this shape is enforced by `satisfies` below).
  const steps = new Map<string, PublicationStepRecord>()

  const store = {
    initializePublicationSteps: async (
      _runId: string,
      _token: string,
      keys: string[]
    ) => {
      initializedSteps.push(keys)
      for (const key of keys)
        steps.set(key, {
          step_key: key,
          status: 'pending',
          attempt_count: 0,
          last_attempt_at: null,
          remote_object_id: null,
          remote_object_url: null,
          failure_code: null,
          failure_message: null
        })
    },
    listPublicationSteps: async () => Array.from(steps.values()),
    requirePublicationStepClaim: async () => {},
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async () => true,
    failPublicationStep: async () => true
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url, body }) => {
    const pathname = new URL(url).pathname
    // The draft-PR base is resolved via the API, not from the payload/persisted
    // default_branch; keep the mock's resolved value aligned with the fixture.
    if (pathname.includes('/branches/')) {
      return githubJson({ commit: { sha: 'resolved-default-sha' } })
    }
    if (pathname.endsWith('/pulls') && method === 'GET') return githubJson([])
    if (pathname.endsWith('/pulls') && method === 'POST') {
      createdPullRequests.push(body)
      return githubJson({
        html_url: 'https://example.test/pull/1',
        number: 1
      })
    }
    if (pathname.includes('/comments') && method === 'GET')
      return githubJson([])
    if (pathname.includes('/comments') && method === 'POST') {
      createdComments.push(body)
      return githubJson({ id: 1, html_url: 'https://example.test/comment/1' })
    }
    if (pathname.includes('/git/blobs')) return githubJson({ sha: 'blob-sha' })
    if (pathname.includes('/git/commits/'))
      return githubJson({ tree: { sha: 'base-tree-sha' } })
    if (pathname.includes('/git/trees')) return githubJson({ sha: 'tree-sha' })
    if (pathname.includes('/git/commits'))
      return githubJson({ sha: 'commit-sha' })
    if (pathname.includes('/git/refs')) return githubJson({})
    return githubJson({ default_branch: 'main' })
  })

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
    store: harness.store,
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
