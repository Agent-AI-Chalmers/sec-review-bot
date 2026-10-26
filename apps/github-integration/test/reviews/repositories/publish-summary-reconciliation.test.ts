// The repository summary steps are reconciled too, not just the delivery draft PRs.
//
// The regression this protects: a publisher created the summary issue (or posted the summary
// comment) and died before recording it. The step then runs out of attempts. Without
// reconciliation the publication reports a failure while the issue or comment is on GitHub, so
// the requester is told nothing was published.
import assert from 'node:assert/strict'
import test from 'node:test'

import { handleRepositoryReviewRun } from '../../../src/reviews/repositories/publish.js'
import { REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE } from '../../../src/reviews/repositories/renderer.js'
import { setGitHubAppMetadata } from '../../../src/github/github-app-metadata-service.js'
import type { PublicationStepStore } from '../../../src/review-runs/client.js'
import { EXECUTION_API_VERSION } from '../../../src/execution/execution-api-version.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

// The summary comment is recognized by this app's bot, so the app identity must be set.
setGitHubAppMetadata({ id: 1, slug: 'sec-review-bot', name: 'Sec Review Bot' })

const RUN_ID = '7d2b1c44-1111-4000-8000-000000000004'
const SUMMARY_COMMENT_MARKER = `<!-- sec-review-bot:repository-summary-run:${RUN_ID} -->`

function exhaustedError(): Error {
  return Object.assign(new Error('no attempts left'), {
    code: 'PUBLICATION_STEP_RETRY_EXHAUSTED'
  })
}

function buildHarness({
  exhaustedStep,
  summaryIssueExists,
  summaryCommentExists
}: {
  exhaustedStep: 'repository:summary-issue' | 'repository:summary-comment'
  summaryIssueExists: boolean
  summaryCommentExists: boolean
}) {
  const settles: Array<{ stepKey: string; found: unknown }> = []
  const postedIssues: unknown[] = []
  const postedComments: unknown[] = []

  const steps = ['repository:summary-issue', 'repository:summary-comment'].map(
    (step_key) => ({
      step_key,
      status: 'pending' as const,
      attempt_count: 0,
      last_attempt_at: null,
      remote_object_id: null,
      remote_object_url: null,
      failure_code: null,
      failure_message: null
    })
  )

  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (
      _runId: string,
      _token: string,
      stepKey: string
    ) => {
      // Only the step under test is out of attempts; everything before it is ready.
      if (stepKey === exhaustedStep) throw exhaustedError()
    },
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async (
      _runId: string,
      _token: string,
      stepKey: string,
      found: unknown
    ) => {
      settles.push({ stepKey, found })
      return true
    },
    failPublicationStep: async () => true
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url, body }) => {
    const pathname = new URL(url).pathname
    if (method === 'GET' && pathname.endsWith('/issues')) {
      return githubJson(
        summaryIssueExists
          ? [
              {
                number: 17,
                title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE,
                pull_request: undefined
              }
            ]
          : []
      )
    }
    if (method === 'POST' && pathname.endsWith('/issues')) {
      postedIssues.push(body)
      return githubJson({ number: 18 })
    }
    if (method === 'GET' && pathname.endsWith('/comments')) {
      return githubJson(
        summaryCommentExists
          ? [
              {
                id: 55,
                html_url: 'https://example.test/c/55',
                body: `${SUMMARY_COMMENT_MARKER}\n\nSummary`,
                user: { login: 'sec-review-bot[bot]', type: 'Bot' }
              }
            ]
          : []
      )
    }
    if (method === 'POST' && pathname.endsWith('/comments')) {
      postedComments.push(body)
      return githubJson({ id: 56, html_url: 'https://example.test/c/56' })
    }
    return githubJson({})
  })

  return { store, octokit, settles, postedIssues, postedComments }
}

async function runPublish(
  harness: ReturnType<typeof buildHarness>
): Promise<void> {
  await handleRepositoryReviewRun({
    run: {
      run_id: RUN_ID,
      publish_context: {
        repo: {
          owner_login: 'octo',
          repo_name: 'example',
          repo_full_name: 'octo/example',
          default_branch: 'main'
        },
        workspace_ref: 'workspace-sha',
        scan_target: {
          target_branch: 'main',
          scan_mode: 'full',
          base_sha: null,
          head_sha: 'head-sha'
        },
        event_type: 'manual'
      }
    },
    result: {
      api_version: EXECUTION_API_VERSION,
      scan_summary: {
        scannable_file_count: 0,
        scanned_file_count: 0,
        skipped_file_count: 0,
        candidate_count: 0,
        case_count: 0,
        suppressed_candidate_count: 0,
        deleted_file_count: 0
      },
      deliveries: [],
      case_results: [],
      deletion_review_skipped: false
    },
    store: harness.store,
    claim_token: 'claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => harness.octokit
  })
}

test('an exhausted summary issue step is settled from the existing summary issue', async () => {
  const harness = buildHarness({
    exhaustedStep: 'repository:summary-issue',
    summaryIssueExists: true,
    summaryCommentExists: false
  })
  await runPublish(harness)

  assert.deepStrictEqual(harness.settles, [
    { stepKey: 'repository:summary-issue', found: { remote: { id: 17 } } }
  ])
  assert.deepStrictEqual(
    harness.postedIssues,
    [],
    'a settled step must not create a second summary issue'
  )
})

test('an exhausted summary comment step is settled from the comment already posted', async () => {
  const harness = buildHarness({
    exhaustedStep: 'repository:summary-comment',
    summaryIssueExists: true,
    summaryCommentExists: true
  })
  await runPublish(harness)

  assert.deepStrictEqual(harness.settles, [
    {
      stepKey: 'repository:summary-comment',
      found: { remote: { id: 55, url: 'https://example.test/c/55' } }
    }
  ])
  assert.deepStrictEqual(
    harness.postedComments,
    [],
    'a settled step must not post the summary comment again'
  )
})
