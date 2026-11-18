import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inputBundlePublicationStore } from '../input-bundle-publication-store.js'
// Covers issue and pull-request trigger behavior at the durable admission,
// preparation-claim, and execution-submission boundaries.
import { expect, afterAll, test } from 'vitest'

import {
  parseIssuePreparationInput,
  parsePullRequestPreparationInput
} from '../../src/review-runs/preparation-input.js'
import { extractIssueContext } from '../../src/github/issue-service.js'
import { startIssueReviewCommand } from '../../src/triggers/issue-review.js'
import { startPullRequestReviewCommand } from '../../src/triggers/pull-request-review.js'
import type { PreparedPullRequestReviewRun } from '../../src/reviews/pull-requests/prepare-review.js'
import type { IssueContext } from '../../src/github/issue-service.js'
import type { PullRequestContext } from '../../src/github/pull-request-service.js'
import { ReviewRunsSubmissionError } from '../../src/review-runs/client.js'
import { EXECUTION_API_VERSION } from '../../src/execution/execution-api-version.js'
import { SetupDeclarationError } from '../../src/github/setup-declaration.js'
import type { IssueReviewInput, PullRequestReviewInput } from '../../src/execution/input.js'
import type { ReviewRunAdmission, ReviewRunRecord } from '../../src/review-runs/client.js'
import { unusedGitHub } from '../github-client.js'

const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-input-'))
const bundlePath = path.join(bundleRoot, 'bundle.tar.zst')
await fs.writeFile(bundlePath, 'x')
afterAll(() => fs.rm(bundleRoot, { recursive: true, force: true }))
const localBundle = {
  uri: pathToFileURL(bundlePath).href,
  digest: `sha256:${createHash('sha256').update('x').digest('hex')}`,
  media_type: 'application/tar+zstd' as const,
  size_bytes: 1
}

/** An admitted run record as Review Runs returns it, with the axis shapes spelled once.
 *
 * The tests below stub `admitReviewRun`, and each stub used to write out the whole record shape
 * and then cast it with `as never`. That cast switched off every check on the shape, so a field
 * added to the contract (or moved between axes) left these stubs compiling while returning
 * something the real service never would. Building the record here keeps one definition and
 * lets the `ReviewRunRecord` type police it.
 */
function admittedRecord(overrides: Partial<ReviewRunRecord> & { run_id: string }): ReviewRunRecord {
  return {
    workflow: 'issue-review',
    source_platform: 'github',
    connector_id: 'github-integration:test',
    publish_context: {},
    preparation: {
      status: 'submitted',
      attempt_count: 1,
      started_at: '2026-01-01T00:00:01.000Z',
      finished_at: '2026-01-01T00:00:02.000Z',
      updated_at: '2026-01-01T00:00:03.000Z',
      failure_code: null,
      disconnect_reason: null
    },
    execution: {
      status: 'pending',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    publication: {
      status: 'pending',
      started_at: null,
      finished_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    created_at: '2026-01-01T00:00:00.000Z',
    failure_code: null,
    failure_message: null,
    artifact_storage: null,
    notices: [],
    ...overrides
  }
}

const TRUSTED_DEFAULT_BRANCH = {
  default_branch: 'main',
  head_sha: 'default-sha'
}

const preparationClaim = {
  checkpointPreparationInput: async () =>
    expect.unreachable('snapshot input must not need checkpointing'),
  ...inputBundlePublicationStore(),
  renewPreparationClaim: async () => true,
  preparationHeartbeatIntervalMs: async () => 60_000
}

function issueContext(): IssueContext {
  return {
    action: 'opened',
    repo_name: 'example-repo',
    repo_full_name: 'octo/example-repo',
    owner_login: 'octo',
    sender_login: 'alice',
    default_branch: 'main',
    issue_number: 12,
    issue_title: 'Example issue',
    issue_body: 'Body',
    issue_author: 'alice',
    issue_state: 'open',
    labels: [],
    html_url: 'https://example.test/issues/12',
    api_url: 'https://api.example.test/issues/12',
    comments_url: 'https://api.example.test/issues/12/comments',
    is_pull_request: false
  }
}

function pullRequestContext(): PullRequestContext {
  return {
    action: 'opened',
    previous_head_sha: null,
    repo_name: 'example-repo',
    repo_full_name: 'octo/example-repo',
    owner_login: 'octo',
    sender_login: 'alice',
    pr_number: 7,
    pr_title: 'Example PR',
    pr_body: 'Body',
    pr_author: 'alice',
    is_draft: false,
    base_ref: 'main',
    base_sha: 'base-sha',
    head_ref: 'feature',
    head_sha: 'head-sha',
    commits: 1,
    changed_files: 1,
    additions: 10,
    deletions: 2,
    html_url: 'https://example.test/pull/7',
    api_url: 'https://api.example.test/pulls/7',
    commits_url: 'https://api.example.test/pulls/7/commits',
    review_comments_url: 'https://api.example.test/pulls/7/comments',
    comments_url: 'https://api.example.test/issues/7/comments',
    issue_url: 'https://api.example.test/issues/7',
    head_repo_full_name: 'octo/example-repo',
    base_repo_full_name: 'octo/example-repo',
    from_fork: false
  }
}

/** A complete `IssueReviewInput`, returned by preparation.
 *
 * `satisfies` keeps this honest: the trigger reads the field set, so an incomplete stub would
 * silently hand it `undefined` where the real submission always supplies a value.
 */
function issueReviewInput(): IssueReviewInput & Record<string, unknown> {
  return {
    api_version: EXECUTION_API_VERSION,
    input_bundle: localBundle,
    review_intent: { objective: 'audit' },
    issue: {
      owner: 'octo',
      repo: 'demo',
      repo_full_name: 'octo/demo',
      number: 7,
      title: 'Update app',
      body: null
    }
  } satisfies IssueReviewInput
}

/** A complete `PullRequestReviewInput`, returned by PR preparation. */
function pullRequestReviewInput(): PullRequestReviewInput & Record<string, unknown> {
  return {
    api_version: EXECUTION_API_VERSION,
    input_bundle: localBundle,
    review_intent: { objective: 'audit' },
    pr: {
      owner: 'octo',
      repo: 'demo',
      repo_full_name: 'octo/demo',
      number: 7,
      title: 'Update app',
      body: null,
      base_ref: 'main',
      base_sha: 'a'.repeat(40),
      head_ref: 'feature',
      head_sha: 'b'.repeat(40),
      commit_shas: ['b'.repeat(40)],
      review_window: {
        kind: 'full',
        base_sha: 'a'.repeat(40),
        head_sha: 'b'.repeat(40),
        reason: 'pull-request-scope'
      }
    }
  } satisfies PullRequestReviewInput
}

test('startIssueReviewCommand starts and persists a queued issue review run', async () => {
  const issue = issueContext()
  const transitions: unknown[] = []
  const phases: string[] = []

  const submitted = await startIssueReviewCommand({
    octokit: unusedGitHub().octokit,
    trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
    issue,
    event_type: 'opened',
    delivery_id: 'delivery-issue-1',
    deps: {
      prepare_review: async ({
        issue: submittedIssue,
        run_id,
        event_type,
        review_objective,
        test_changes
      }) => {
        expect(run_id).toBe('run-issue-1')
        expect(event_type).toBe('opened')
        expect(review_objective).toBe('audit')
        expect(test_changes).toBe(null)
        const prepared = {
          issue: submittedIssue,
          run_id: 'run-issue-1',
          workspace_ref: 'workspace-ref',
          workflow: 'issue-review',
          event_type: 'opened' as const,
          open_pr: false
        }
        phases.push('prepared')
        return { review: prepared, input: issueReviewInput() }
      },
      store: {
        ...preparationClaim,
        renewPreparationClaim: async () => {
          phases.push('renew')
          return true
        },
        reserveInputBundleCandidate: async (...args) => {
          phases.push('reserve')
          return await inputBundlePublicationStore().reserveInputBundleCandidate(...args)
        },
        settleInputBundleCandidate: async (...args) => {
          phases.push('present')
          return await inputBundlePublicationStore().settleInputBundleCandidate(...args)
        },
        admitReviewRun: (run) => {
          transitions.push(['pending', withoutPreparationInput(run)])
          return {
            record: admittedRecord({ ...run, run_id: 'run-issue-1' }),
            created: true,
            preparation_token: 'claim'
          }
        },
        submitPreparedRun: (run_id, _token, publish_context) => {
          phases.push('submit')
          transitions.push(['queued', run_id, publish_context])
        },
        failPreparation: () => expect.unreachable('successful review must not be marked failed')
      }
    }
  })

  expect(submitted.run_id).toBe('run-issue-1')
  expect(phases).toStrictEqual(['renew', 'prepared', 'renew', 'reserve', 'present', 'submit'])
  expect(transitions).toStrictEqual([
    [
      'pending',
      {
        workflow: 'issue-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'delivery-issue-1'
      }
    ],
    [
      'queued',
      'run-issue-1',
      {
        issue: {
          owner_login: 'octo',
          repo_name: 'example-repo',
          repo_full_name: 'octo/example-repo',
          default_branch: 'main',
          issue_number: 12,
          issue_title: 'Example issue'
        },
        workspace_ref: 'workspace-ref',
        event_type: 'opened',
        open_pr: false
      }
    ]
  ])
})

test('startPullRequestReviewCommand starts and persists a queued PR review run', async () => {
  const pr = pullRequestContext()
  const transitions: unknown[] = []

  const submitted = await startPullRequestReviewCommand({
    octokit: unusedGitHub().octokit,
    trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
    pr,
    event_type: 'manual_review',
    delivery_id: 'delivery-pr-1',
    test_changes: 'deny',
    deps: {
      prepare_review: async ({ pr: submittedPr, run_id, event_type, test_changes }) => {
        expect(run_id).toBe('run-pr-1')
        expect(event_type).toBe('manual_review')
        expect(test_changes).toBe('deny')
        const prepared = {
          pr: submittedPr,
          run_id: 'run-pr-1',
          files: [{ filename: 'src/app.ts' }],
          workflow: 'pull-request-review',
          event_type: 'manual_review' as const
        }
        return { review: prepared, input: pullRequestReviewInput() }
      },
      store: {
        ...preparationClaim,
        admitReviewRun: (run) => {
          transitions.push(['pending', withoutPreparationInput(run)])
          return {
            record: admittedRecord({ ...run, run_id: 'run-pr-1' }),
            created: true,
            preparation_token: 'claim'
          }
        },
        submitPreparedRun: (run_id, _token, publish_context) =>
          transitions.push(['queued', run_id, publish_context]),
        failPreparation: () => expect.unreachable('successful review must not be marked failed')
      }
    }
  })

  expect(submitted.run_id).toBe('run-pr-1')
  expect(transitions).toStrictEqual([
    [
      'pending',
      {
        workflow: 'pull-request-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'delivery-pr-1'
      }
    ],
    [
      'queued',
      'run-pr-1',
      {
        files: [{ filename: 'src/app.ts' }],
        pr: {
          owner_login: 'octo',
          repo_name: 'example-repo',
          repo_full_name: 'octo/example-repo',
          pr_number: 7,
          pr_author: 'alice',
          head_sha: 'head-sha'
        },
        event_type: 'manual_review'
      }
    ]
  ])
})

test('startPullRequestReviewCommand records a failed run when preparation or submission fails', async () => {
  // The run is deliberately admitted before preparation fails: operators must
  // be able to find the failed attempt and its delivery identity afterwards.
  const transitions: unknown[] = []

  await expect(
    startPullRequestReviewCommand({
      octokit: unusedGitHub().octokit,
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      pr: pullRequestContext(),
      event_type: 'opened',
      delivery_id: 'delivery-pr-failed',
      deps: {
        prepare_review: async ({ run_id }) => {
          expect(run_id).toBe('run-pr-failed')
          throw new Error('workspace clone failed')
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            transitions.push(['pending', withoutPreparationInput(run)])
            return {
              record: admittedRecord({ ...run, run_id: 'run-pr-failed' }),
              created: true,
              preparation_token: 'claim'
            }
          },
          submitPreparedRun: () => expect.unreachable('failed review must not be queued'),
          failPreparation: (run_id, _token, error) => transitions.push(['failed', run_id, error])
        }
      }
    })
  ).rejects.toThrow(/workspace clone failed/)

  expect(transitions).toStrictEqual([
    [
      'pending',
      {
        workflow: 'pull-request-review',
        publish_context: {},
        ingress_kind: 'github_webhook',
        ingress_key: 'delivery-pr-failed'
      }
    ],
    ['failed', 'run-pr-failed', { code: 'REVIEW_START_FAILED', message: 'workspace clone failed' }]
  ])
})

test('startIssueReviewCommand preserves an uncertain Execution submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new ReviewRunsSubmissionError(
    'Execution response was lost.',
    'SUBMISSION_STATE_UNCERTAIN'
  )

  await expect(
    startIssueReviewCommand({
      octokit: unusedGitHub().octokit,
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      issue: issueContext(),
      event_type: 'opened',
      delivery_id: 'delivery-uncertain',
      deps: {
        prepare_review: async (args) => {
          return {
            review: {
              issue: args.issue,
              run_id: 'run-uncertain',
              workspace_ref: 'workspace-ref',
              workflow: 'issue-review',
              event_type: 'opened',
              open_pr: false
            },
            input: issueReviewInput()
          }
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) =>
            ({
              record: admittedRecord({ ...run, run_id: 'run-uncertain' }),
              created: true,
              preparation_token: 'claim'
            }) satisfies ReviewRunAdmission,
          submitPreparedRun: (run_id, _token, context, input) => {
            transitions.push(['prepared', run_id, context, input])
            throw error
          },
          failPreparation: (run_id, _token, failure) => transitions.push([run_id, failure])
        }
      }
    })
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })

  expect((transitions[0] as unknown[])[0]).toBe('prepared')
  expect(transitions).toHaveLength(1)
})

test('startPullRequestReviewCommand preserves an uncertain Execution submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new ReviewRunsSubmissionError(
    'Execution response was lost.',
    'SUBMISSION_STATE_UNCERTAIN'
  )

  await expect(
    startPullRequestReviewCommand({
      octokit: unusedGitHub().octokit,
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      pr: pullRequestContext(),
      event_type: 'opened',
      delivery_id: 'delivery-pr-uncertain',
      deps: {
        prepare_review: async (args) => {
          return {
            review: {
              pr: args.pr,
              run_id: 'run-pr-uncertain',
              files: [],
              workflow: 'pull-request-review',
              event_type: 'opened'
            },
            input: pullRequestReviewInput()
          }
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) =>
            ({
              record: admittedRecord({ ...run, run_id: 'run-pr-uncertain' }),
              created: true,
              preparation_token: 'claim'
            }) satisfies ReviewRunAdmission,
          submitPreparedRun: (run_id, _token, context, input) => {
            transitions.push(['prepared', run_id, context, input])
            throw error
          },
          failPreparation: (run_id, _token, failure) => transitions.push([run_id, failure])
        }
      }
    })
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })

  expect((transitions[0] as unknown[])[0]).toBe('prepared')
  expect(transitions).toHaveLength(1)
})

test('startPullRequestReviewCommand admits a comment delivery before loading PR context', async () => {
  const transitions: unknown[] = []

  await expect(
    startPullRequestReviewCommand({
      octokit: unusedGitHub().octokit,
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      event_type: 'manual_review',
      delivery_id: 'delivery-context-failure',
      pr_reference: {
        owner_login: 'octo',
        repo_name: 'example',
        pr_number: 7
      },
      deps: {
        get_pull_request_context: async () => {
          transitions.push(['context'])
          throw new Error('GitHub PR lookup failed')
        },
        prepare_review: async () => expect.unreachable('review must not start without PR context'),
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            transitions.push(['pending', 'run-context-failure'])
            return {
              record: admittedRecord({ ...run, run_id: 'run-context-failure' }),
              created: true,
              preparation_token: 'claim'
            } satisfies ReviewRunAdmission
          },
          submitPreparedRun: () => expect.unreachable('failed context lookup must not queue'),
          failPreparation: (run_id, _token, error) => transitions.push(['failed', run_id, error])
        }
      }
    })
  ).rejects.toThrow(/GitHub PR lookup failed/)

  expect(transitions).toStrictEqual([
    ['pending', 'run-context-failure'],
    ['context'],
    [
      'failed',
      'run-context-failure',
      { code: 'REVIEW_START_FAILED', message: 'GitHub PR lookup failed' }
    ]
  ])
})

for (const recovering of [false, true]) {
  test(`startPullRequestReviewCommand checkpoints a resolved comment PR before preparation (recovery: ${recovering})`, async () => {
    const pr = pullRequestContext()
    const checkpoints: unknown[][] = []
    await startPullRequestReviewCommand({
      octokit: unusedGitHub().octokit,
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      event_type: 'manual_review',
      delivery_id: 'delivery-checkpoint',
      ...(recovering ? { claimed_preparation: { run_id: 'run-checkpoint', token: 'claim' } } : {}),
      pr_reference: {
        owner_login: 'octo',
        repo_name: 'example-repo',
        pr_number: 7
      },
      deps: {
        get_pull_request_context: async () => pr,
        prepare_review: async ({ pr: preparedPr }) => {
          expect(preparedPr).toBe(pr)
          expect(checkpoints).toHaveLength(1)
          const review = {
            pr: preparedPr,
            run_id: 'run-checkpoint',
            files: [],
            workflow: 'pull-request-review',
            event_type: 'manual_review'
          } satisfies PreparedPullRequestReviewRun
          return { review, input: pullRequestReviewInput() }
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            expect(recovering, 'recovery must reuse its claim').toBe(false)
            return {
              record: admittedRecord({ ...run, run_id: 'run-checkpoint' }),
              created: true,
              preparation_token: 'claim'
            } satisfies ReviewRunAdmission
          },
          checkpointPreparationInput: async (...args) => {
            const recovered = parsePullRequestPreparationInput(JSON.parse(JSON.stringify(args[2])))
            expect(recovered.pr).toStrictEqual(pr)
            checkpoints.push(args)
          },
          submitPreparedRun: () => {},
          failPreparation: () => expect.unreachable('checkpointed review must not fail')
        }
      }
    })
    expect(checkpoints).toStrictEqual([
      [
        'run-checkpoint',
        'claim',
        {
          kind: 'github_pull_request_review',
          trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
          event_type: 'manual_review',
          test_changes: null,
          pr
        }
      ]
    ])
  })
}

test('startPullRequestReviewCommand reuses a webhook delivery without starting another review', async () => {
  let starts = 0
  const submitted = await startPullRequestReviewCommand({
    octokit: unusedGitHub().octokit,
    trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
    pr: pullRequestContext(),
    event_type: 'opened',
    delivery_id: 'delivery-1',
    deps: {
      prepare_review: async () => {
        starts += 1
        throw new Error('replayed delivery must not start')
      },
      store: {
        ...preparationClaim,
        admitReviewRun: () => ({
          created: false,
          preparation_token: null,
          record: admittedRecord({
            run_id: 'run-original',
            execution: {
              status: 'queued',
              started_at: null,
              finished_at: null,
              updated_at: '2026-01-01T00:00:00.000Z'
            }
          })
        }),
        submitPreparedRun: () => expect.unreachable('replayed delivery must not queue again'),
        failPreparation: () =>
          expect.unreachable('replayed delivery must not change the original run')
      }
    }
  })

  expect(submitted.run_id).toBe('run-original')
  expect(starts).toBe(0)
})

test('startIssueReviewCommand reuses a webhook delivery without starting another review', async () => {
  let starts = 0
  const submitted = await startIssueReviewCommand({
    octokit: unusedGitHub().octokit,
    trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
    issue: issueContext(),
    event_type: 'opened',
    delivery_id: 'delivery-issue-1',
    deps: {
      prepare_review: async () => {
        starts += 1
        throw new Error('replayed delivery must not start')
      },
      store: {
        ...preparationClaim,
        admitReviewRun: () => ({
          created: false,
          preparation_token: null,
          record: admittedRecord({
            run_id: 'run-original',
            execution: {
              status: 'queued',
              started_at: null,
              finished_at: null,
              updated_at: '2026-01-01T00:00:00.000Z'
            }
          })
        }),
        submitPreparedRun: () => expect.unreachable('replayed delivery must not queue again'),
        failPreparation: () =>
          expect.unreachable('replayed delivery must not change the original run')
      }
    }
  })

  expect(submitted.run_id).toBe('run-original')
  expect(starts).toBe(0)
})

test('startPullRequestReviewCommand reports an invalid setup declaration distinctly', async () => {
  const transitions: unknown[] = []

  await expect(
    startPullRequestReviewCommand({
      octokit: unusedGitHub().octokit,
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      pr: pullRequestContext(),
      event_type: 'opened',
      delivery_id: 'delivery-pr-setup-invalid',
      deps: {
        prepare_review: async () => {
          throw new SetupDeclarationError('setup[0] has unsupported key(s): shell', {
            reason: 'unsupported-step-key'
          })
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) =>
            ({
              record: admittedRecord({
                ...run,
                run_id: 'run-pr-setup-invalid'
              }),
              created: true,
              preparation_token: 'claim'
            }) satisfies ReviewRunAdmission,
          submitPreparedRun: () => expect.unreachable('invalid setup must not be queued'),
          failPreparation: (run_id, _token, error) => transitions.push(['failed', run_id, error])
        }
      }
    })
  ).rejects.toThrow(SetupDeclarationError)

  expect(transitions).toStrictEqual([
    [
      'failed',
      'run-pr-setup-invalid',
      {
        code: 'SETUP_DECLARATION_INVALID',
        message: 'setup[0] has unsupported key(s): shell'
      }
    ]
  ])
})

test('startIssueReviewCommand reports an invalid setup declaration distinctly', async () => {
  const transitions: unknown[] = []

  await expect(
    startIssueReviewCommand({
      octokit: unusedGitHub().octokit,
      issue: issueContext(),
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      event_type: 'manual_review',
      delivery_id: 'delivery-issue-setup-invalid',
      deps: {
        prepare_review: async () => {
          throw new SetupDeclarationError('setup declaration is not valid YAML', {
            reason: 'invalid-yaml'
          })
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) =>
            ({
              record: admittedRecord({
                ...run,
                run_id: 'run-issue-setup-invalid'
              }),
              created: true,
              preparation_token: 'claim'
            }) satisfies ReviewRunAdmission,
          submitPreparedRun: () => expect.unreachable('invalid setup must not be queued'),
          failPreparation: (run_id, _token, error) => transitions.push(['failed', run_id, error])
        }
      }
    })
  ).rejects.toThrow(SetupDeclarationError)

  expect(transitions).toStrictEqual([
    [
      'failed',
      'run-issue-setup-invalid',
      {
        code: 'SETUP_DECLARATION_INVALID',
        message: 'setup declaration is not valid YAML'
      }
    ]
  ])
})

function withoutPreparationInput<
  T extends { preparation_input?: unknown; preparation_input_version?: unknown }
>(run: T): Omit<T, 'preparation_input' | 'preparation_input_version'> {
  const rest = { ...run }
  delete rest.preparation_input
  delete rest.preparation_input_version
  return rest
}

test('admission output roundtrips through recovery using the actual issue producer', async () => {
  const issue = extractIssueContext({
    action: 'opened',
    repository: {
      name: 'example',
      full_name: 'octo/example',
      owner: { login: 'octo' },
      default_branch: 'main'
    },
    issue: { number: 1, title: 'Claim', state: 'open' }
  })
  let parsed = false
  await startIssueReviewCommand({
    octokit: unusedGitHub().octokit,
    issue,
    trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
    event_type: 'manual_review',
    review_objective: 'repair',
    test_changes: 'deny',
    open_pr: true,
    delivery_id: 'roundtrip',
    deps: {
      store: {
        ...preparationClaim,
        admitReviewRun: (run) => {
          const recovered = parseIssuePreparationInput(
            JSON.parse(JSON.stringify(run.preparation_input))
          )
          expect(recovered.issue).toStrictEqual(issue)
          expect(recovered.review_objective).toBe('repair')
          expect(recovered.test_changes).toBe('deny')
          expect(recovered.open_pr).toBe(true)
          parsed = true
          return {
            record: admittedRecord({ ...run, run_id: 'roundtrip' }),
            created: false,
            preparation_token: null
          }
        },
        submitPreparedRun: () => expect.unreachable('a replay must not submit'),
        failPreparation: () => expect.unreachable('a replay must not fail')
      }
    }
  })
  expect(parsed).toBe(true)
})

test('a failed PR checkpoint prevents preparation and submission', async () => {
  const error = new Error('checkpoint transport failed')
  const failures: unknown[][] = []
  await expect(
    startPullRequestReviewCommand({
      octokit: unusedGitHub().octokit,
      pr_reference: {
        owner_login: 'octo',
        repo_name: 'example-repo',
        pr_number: 7
      },
      trusted_default_branch: TRUSTED_DEFAULT_BRANCH,
      event_type: 'manual_review',
      delivery_id: 'checkpoint-failure',
      claimed_preparation: { run_id: 'existing-run', token: 'claim' },
      deps: {
        get_pull_request_context: async () => pullRequestContext(),
        prepare_review: async () =>
          expect.unreachable('an uncheckpointed snapshot must not prepare'),
        store: {
          ...preparationClaim,
          admitReviewRun: () => expect.unreachable('a retry must not admit again'),
          checkpointPreparationInput: async () => {
            throw error
          },
          submitPreparedRun: () => expect.unreachable('an uncheckpointed snapshot must not submit'),
          failPreparation: (...args) => {
            failures.push(args)
          }
        }
      }
    })
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })
  expect(failures).toHaveLength(1)
  expect(failures[0]?.slice(0, 3)).toStrictEqual([
    'existing-run',
    'claim',
    { code: 'REVIEW_START_FAILED', message: error.message }
  ])
})
