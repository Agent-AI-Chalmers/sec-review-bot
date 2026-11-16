// A publication step with no attempts left is reconciled against GitHub, not declared failed.
//
// The regression this protects: a publisher started a side effect (posted the summary comment, or
// opened the draft PR), then died or lost the response before recording it. Review Runs spends
// the step's attempts and reports "no attempts left". Before reconciliation existed, that report
// was itself the conclusion, so the run failed and the requester was told nothing was published
// while the comment or PR was already on GitHub.
import assert from 'node:assert/strict'
import test from 'node:test'

import { handleIssueReviewRun } from '../../../src/reviews/issues/publish.js'
import {
  isRecordedReconciliationFailure,
  unrecordedRecoveryAttemptCount,
  settleExhaustedStep
} from '../../../src/reviews/shared/settle-exhausted-step.js'
import { EXECUTION_PUBLISH_ERROR_CODES } from '../../../src/execution/publish-error-code.js'
import type { PublicationStepStore } from '../../../src/review-runs/client.js'
import type { ReviewRecord } from '../../../src/reviews/review-record.js'
import { EXECUTION_API_VERSION } from '../../../src/execution/execution-api-version.js'
import { fakeGitHub, githubJson } from '../../github-client.js'
import { setGitHubAppMetadata } from '../../../src/github/github-app-metadata-service.js'

// The marker lookup only counts comments authored by this app, so the app identity must be set.
setGitHubAppMetadata({ id: 1, slug: 'sec-review-bot', name: 'Sec Review Bot' })

function reviewRecord(): ReviewRecord {
  return {
    analysis: {
      verdict: 'confirmed-vulnerability',
      overview: 'No patch needed.',
      narratives: []
    },
    mitigation: {
      overview: 'Nothing to change.',
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: null,
      target_claim: null,
      validation_level: null,
      coverage: 'full',
      regression: 'not-run',
      next_step: 'none',
      findings: [],
      evidence: [],
      residual_risks: []
    },
    cvss: null
  } as ReviewRecord
}

const RUN_ID = '6f1c2f9e-0000-4000-8000-000000000001'

/** The comment a previous attempt would have posted: this app's bot, carrying this run's marker. */
function postedComment(): {
  id: number
  html_url: string
  body: string
  user: unknown
} {
  return {
    id: 4242,
    html_url: 'https://example.test/c/4242',
    body: `<!-- sec-review-bot:issue-review-run:${RUN_ID} -->\n\nSummary`,
    user: { login: 'sec-review-bot[bot]', type: 'Bot' }
  }
}

/** The error Review Runs raises when a step has no attempts left. */
function exhaustedError(): Error {
  return Object.assign(new Error('no attempts left'), {
    code: EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
  })
}

function buildHarness({
  existingComment = null as {
    id: number
    html_url: string
    body: string
    user: unknown
  } | null,
  settleResult = true
}: {
  existingComment?: {
    id: number
    html_url: string
    body: string
    user: unknown
  } | null
  settleResult?: boolean
} = {}) {
  const settles: Array<{ stepKey: string; found: unknown }> = []
  const postedComments: unknown[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => [],
    // The step has no attempts left: claiming it raises the exhaustion signal.
    requirePublicationStepClaim: async () => {
      throw exhaustedError()
    },
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async (
      _runId: string,
      _token: string,
      stepKey: string,
      found: unknown
    ) => {
      settles.push({ stepKey, found })
      return settleResult
    },
    failPublicationStep: async () => true
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url }) => {
    const pathname = new URL(url).pathname
    if (pathname.includes('/comments') && method === 'GET')
      return githubJson(existingComment === null ? [] : [existingComment])
    if (pathname.includes('/comments') && method === 'POST') {
      postedComments.push({ method })
      return githubJson({ id: 99, html_url: 'https://example.test/c/99' })
    }
    if (pathname.includes('/pulls') && method === 'GET') return githubJson([])
    if (pathname.includes('/branches/'))
      return githubJson({ commit: { sha: 'resolved-default-sha' } })
    return githubJson({ default_branch: 'main' })
  })

  return { store, octokit, settles, postedComments }
}

async function runPublish(
  harness: ReturnType<typeof buildHarness>
): Promise<void> {
  await handleIssueReviewRun({
    run: {
      run_id: RUN_ID,
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
        open_pr: false
      }
    },
    result: {
      api_version: EXECUTION_API_VERSION,
      review_record: reviewRecord()
    },
    store: harness.store,
    claim_token: 'claim',
    assert_publication_claim: async () => {},
    installation_octokit_for_repo: async () => harness.octokit
  })
}

test('an exhausted comment step that already posted is settled as succeeded', async () => {
  // The comment exists under this run's marker, so the step's work was done even though no
  // attempt is left to record it. The run must not be failed, and nothing new may be posted.
  const harness = buildHarness({ existingComment: postedComment() })
  await runPublish(harness)

  assert.deepStrictEqual(harness.settles, [
    {
      stepKey: 'issue:summary-comment',
      found: { remote: { id: 4242, url: 'https://example.test/c/4242' } }
    }
  ])
  assert.deepStrictEqual(
    harness.postedComments,
    [],
    'a reconciliation discovers the side effect; it must never take a new one'
  )
})

test('an exhausted comment step with no comment on GitHub stays a failure', async () => {
  // The connector looked and found nothing, which is the only evidence that makes the step a
  // real failure. The exhaustion error is then what the caller reports.
  const harness = buildHarness({ existingComment: null })
  await assert.rejects(runPublish(harness), (error: unknown) => {
    return (
      error instanceof Error &&
      'code' in error &&
      error.code ===
        EXECUTION_PUBLISH_ERROR_CODES.publication_step_retry_exhausted
    )
  })
  assert.deepStrictEqual(
    harness.settles,
    [{ stepKey: 'issue:summary-comment', found: null }],
    'the reconciliation looked and found nothing, which is the evidence that makes it terminal'
  )
})

test('a reconciliation that loses the step reports the failure rather than claiming success', async () => {
  // Another owner concluded the step while this one was looking. `settle` answered false, so
  // this caller may not treat the step as its own success.
  const harness = buildHarness({
    existingComment: postedComment(),
    settleResult: false
  })
  await assert.rejects(runPublish(harness))
})

test('a recorded absence and a refused write are not conflated', async () => {
  // Both outcomes stop this caller, but they are different facts: one is a conclusion this
  // caller wrote to the step, the other means another owner is in charge and nothing was
  // written. The outcome names carry that distinction, so a caller cannot read an absence as
  // "nothing was written".
  const absent = await settleExhaustedStep({
    store: {
      listPublicationSteps: async () => [],
      settleExhaustedPublicationStep: async () => true
    } as unknown as PublicationStepStore,
    runId: RUN_ID,
    token: 'claim',
    stepKey: 'issue:summary-comment',
    find: async () => null
  })
  const lost = await settleExhaustedStep({
    store: {
      listPublicationSteps: async () => [],
      settleExhaustedPublicationStep: async () => false
    } as unknown as PublicationStepStore,
    runId: RUN_ID,
    token: 'claim',
    stepKey: 'issue:summary-comment',
    find: async () => null
  })
  assert.deepStrictEqual(absent, {
    outcome: 'recorded',
    step: 'terminal_failed'
  })
  assert.deepStrictEqual(lost, { outcome: 'not_owned' })
})

test('every outcome names whether the step was written, so a caller need not infer it', async () => {
  // The write path decides whether the step is `succeeded`, `terminal_failed`, or untouched. The
  // outcome says which, and names the recorded state in the schema's own words, so a caller never
  // has to know which branch of `settleExhaustedStep` wrote.
  const settledWith = async (
    accepted: boolean,
    found: { id: number; url: string } | null
  ) =>
    await settleExhaustedStep({
      store: {
        listPublicationSteps: async () => [],
        settleExhaustedPublicationStep: async () => accepted
      } as unknown as PublicationStepStore,
      runId: RUN_ID,
      token: 'claim',
      stepKey: 'issue:summary-comment',
      find: async () => found
    })

  const succeeded = await settledWith(true, {
    id: 4242,
    url: 'https://example.test/c/4242'
  })
  const absent = await settledWith(true, null)
  const notOwned = await settledWith(false, null)

  assert.deepStrictEqual(succeeded, {
    outcome: 'recorded',
    step: 'succeeded',
    remote: { id: 4242, url: 'https://example.test/c/4242' }
  })
  // Only `recorded` outcomes claim a write; `not_owned` must never be read as one, which is why
  // it is not called `absent` or `failed`.
  assert.deepStrictEqual(absent, {
    outcome: 'recorded',
    step: 'terminal_failed'
  })
  assert.deepStrictEqual(notOwned, { outcome: 'not_owned' })
  assert.ok(
    !('remote' in absent) && !('remote' in notOwned),
    'only a recorded success carries the remote reference'
  )
})

test('a reconciliation that cannot reach GitHub records the failure but settles nothing', async () => {
  // A lookup that failed is not a lookup that found nothing. Settling it as absent would record
  // `terminal_failed` for a step whose comment may well be on GitHub, so nothing is settled and the
  // error propagates. It is still recorded as a failed reconciliation, retryable when transient:
  // that is what spends the step's reconciliation budget, so a remote that keeps failing parks the
  // step for an operator instead of being retried forever.
  let settled = false
  const failures: Array<{ code: string | null | undefined; retry: unknown }> =
    []
  await assert.rejects(
    settleExhaustedStep({
      store: {
        listPublicationSteps: async () => [],
        settleExhaustedPublicationStep: async () => {
          settled = true
          return true
        },
        failPublicationStep: async (
          _runId: string,
          _token: string,
          _stepKey: string,
          error: { code?: string | null },
          options: { retry?: boolean }
        ) => {
          failures.push({ code: error.code, retry: options.retry })
          return true
        }
      } as unknown as PublicationStepStore,
      runId: RUN_ID,
      token: 'claim',
      stepKey: 'issue:summary-comment',
      find: async () => {
        throw Object.assign(new Error('GitHub answered 502'), { status: 502 })
      }
    }),
    /502/
  )
  assert.strictEqual(settled, false)
  assert.deepStrictEqual(failures, [{ code: null, retry: true }])
})

test('a lookup that throws a non-object is still marked as recorded', async () => {
  // The caller that records step failures itself skips one already recorded here. A thrown
  // primitive cannot carry that mark, so it is wrapped; otherwise it would be recorded twice.
  const thrown = await settleExhaustedStep({
    store: {
      listPublicationSteps: async () => [],
      settleExhaustedPublicationStep: async () => true,
      failPublicationStep: async () => true
    } as unknown as PublicationStepStore,
    runId: RUN_ID,
    token: 'claim',
    stepKey: 'issue:summary-comment',
    find: async () => {
      throw 'lookup exploded'
    }
  }).then(
    () => assert.fail('the lookup failure must propagate'),
    (error: unknown) => error
  )
  assert.ok(isRecordedReconciliationFailure(thrown))
  assert.match(String((thrown as Error).message), /lookup exploded/)
})

test('a lookup failure whose first report is lost is recorded by the retry', async () => {
  // Issue and pull-request steps have no caller that records the failure again, so the retry
  // here is what keeps a lost response from leaving the pass unrecorded.
  let calls = 0
  const thrown = await settleExhaustedStep({
    store: {
      listPublicationSteps: async () => [],
      settleExhaustedPublicationStep: async () => true,
      failPublicationStep: async () => {
        calls += 1
        if (calls === 1)
          throw Object.assign(new Error('Review Runs timed out'), {
            status: 504
          })
        return true
      }
    } as unknown as PublicationStepStore,
    runId: RUN_ID,
    token: 'claim',
    stepKey: 'issue:summary-comment',
    find: async () => {
      throw Object.assign(new Error('GitHub answered 502'), { status: 502 })
    }
  }).then(
    () => assert.fail('the lookup failure must propagate'),
    (error: unknown) => error
  )
  assert.strictEqual(calls, 2)
  assert.ok(isRecordedReconciliationFailure(thrown))
})

test('a lookup failure whose recording did not complete is reported again against the same count', async () => {
  // Whether a write committed is unknown when its response is lost. The report is retried once
  // against the count read before the lookup, so if the first write did commit, Review Runs sees
  // the count has moved and does not spend the budget again. If both fail, the lookup error
  // propagates unmarked with that count, for a caller that records step failures itself.
  const reported: Array<number | undefined> = []
  const thrown = await settleExhaustedStep({
    store: {
      listPublicationSteps: async () => [
        {
          step_key: 'issue:summary-comment',
          status: 'uncertain',
          attempt_count: 3,
          last_attempt_at: null,
          recovery_attempt_count: 1,
          remote_object_id: null,
          remote_object_url: null,
          failure_code: null,
          failure_message: null
        }
      ],
      settleExhaustedPublicationStep: async () => true,
      failPublicationStep: async (
        _runId: string,
        _token: string,
        _stepKey: string,
        _error: unknown,
        options: { expectedRecoveryAttemptCount?: number }
      ) => {
        reported.push(options.expectedRecoveryAttemptCount)
        throw Object.assign(new Error('Review Runs timed out'), {
          status: 504
        })
      }
    } as unknown as PublicationStepStore,
    runId: RUN_ID,
    token: 'claim',
    stepKey: 'issue:summary-comment',
    find: async () => {
      throw Object.assign(new Error('GitHub answered 502'), { status: 502 })
    }
  }).then(
    () => assert.fail('the lookup failure must propagate'),
    (error: unknown) => error
  )
  assert.deepStrictEqual(
    reported,
    [1, 1],
    'retried once, against the same count both times'
  )
  assert.match(String((thrown as Error).message), /502/)
  assert.ok(!isRecordedReconciliationFailure(thrown))
  assert.strictEqual(unrecordedRecoveryAttemptCount(thrown), 1)
})
