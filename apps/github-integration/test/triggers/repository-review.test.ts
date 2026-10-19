// Covers repository-dispatch admission, preparation, and submission boundaries
// with controlled connector and Control Plane dependencies.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from 'octokit'

import { appWithInstallationOctokit } from '../github-app-stubs.js'
import {
  dispatchRepositoryReview,
  resolveRepositoryReviewDispatch,
  RepositoryReviewDispatchValidationError
} from '../../src/triggers/repository-review.js'
import type { GitHubAppOctokit } from '../../src/github/octokit.js'
import { ControlPlaneSubmissionError } from '../../src/control-plane/client.js'

/** An admitted run record as the Control Plane returns it, with the axis shapes spelled once.
 *
 * The tests below stub `admitReviewRun`, and each stub used to write out the whole record shape
 * and then cast it with `as never`. That cast switched off every check on the shape, so a field
 * added to the contract (or moved between axes) left these stubs compiling while returning
 * something the real service never would. Building the record here keeps one definition and
 * lets the `ReviewRunRecord` type police it.
 */
function admittedRecord(
  overrides: Partial<ReviewRunRecord> & { run_id: string }
): ReviewRunRecord {
  return {
    workflow: 'issue-review',
    publish_context: {},
    preparation: {
    status: 'submitted',
    attempt_count: 1,
    started_at: '2026-01-01T00:00:01.000Z',
    finished_at: '2026-01-01T00:00:02.000Z',
    updated_at: '2026-01-01T00:00:03.000Z',
    failure_code: null,
    failure_notice_status: null
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
    ...overrides
  }
}

const preparationClaim = {
  renewPreparationClaim: async () => true,
  preparationHeartbeatIntervalMs: async () => 60_000
}
import type { SubmittedRepositoryReviewRun } from '../../src/reviews/repositories/submit.js'
import type { ReviewRunRecord } from '../../src/control-plane/client.js'
import { CONTRACT_VERSION } from '../../src/runner/contract-version.js'

function fakeApp(): App {
  return appWithInstallationOctokit({
    installation_octokit: {
      installation_id: 123
    } as unknown as GitHubAppOctokit,
    expected_owner: 'octo',
    expected_repo: 'example'
  })
}

function octokitWithRefs(): GitHubAppOctokit {
  return {
    rest: {
      repos: {
        getBranch: async ({ branch }: { branch: string }) => {
          if (branch !== 'main') {
            throw new Error('not a branch')
          }
          return {
            data: {
              commit: {
                sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
              }
            }
          }
        },
        getCommit: async ({ ref }: { ref: string }) => ({
          data: {
            sha:
              ref === 'aaaaaaaa'
                ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                : ref === 'cccccccc'
                  ? 'cccccccccccccccccccccccccccccccccccccccc'
                  : String(ref)
          }
        }),
        listCommits: async () => ({
          data: [
            {
              sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              commit: {
                message: 'base',
                author: {
                  date: '2026-05-24T00:00:00Z'
                }
              }
            }
          ]
        })
      }
    }
  } as unknown as GitHubAppOctokit
}

test('repository dispatch request resolves scheduled incremental window in the app layer', async () => {
  const resolved = await resolveRepositoryReviewDispatch({
    octokit: octokitWithRefs(),
    payload: {
      repo_full_name: 'octo/example',
      target_branch: 'main',
      event_type: 'scheduled',
      schedule: '0 3 * * 1',
      correlation_id: 'scheduled-run-1'
    }
  })

  assert.strictEqual(resolved.scan_mode, 'incremental')
  assert.strictEqual(resolved.event_type, 'scheduled')
  assert.strictEqual(resolved.target_branch, 'main')
  assert.strictEqual(
    resolved.head_sha,
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )
  assert.strictEqual(
    resolved.base_sha,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )
})

test('repository dispatch request resolves manual incremental refs from raw payload', async () => {
  const resolved = await resolveRepositoryReviewDispatch({
    octokit: octokitWithRefs(),
    payload: {
      repo_full_name: 'octo/example',
      target_branch: 'main',
      scan_mode: 'incremental',
      base_sha: 'aaaaaaaa',
      head_sha: 'cccccccc',
      event_type: 'manual',
      test_changes: 'deny',
      correlation_id: 'manual-run-1'
    }
  })

  assert.strictEqual(resolved.scan_mode, 'incremental')
  assert.strictEqual(resolved.event_type, 'manual')
  assert.strictEqual(
    resolved.base_sha,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )
  assert.strictEqual(
    resolved.head_sha,
    'cccccccccccccccccccccccccccccccccccccccc'
  )
  assert.strictEqual(resolved.test_changes, 'deny')
})

test('dispatchRepositoryReview resolves, submits, and persists a queued repository review run', async () => {
  const octokit = { test: 'octokit' } as unknown as GitHubAppOctokit
  const saved_runs: unknown[] = []
  const submit_calls: unknown[] = []
  const resolved = {
    repo_full_name: 'octo/example',
    target_branch: 'main',
    scan_mode: 'incremental' as const,
    base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    event_type: 'manual' as const,
    test_changes: 'deny' as const,
    correlation_id: 'actions-run-1'
  }

  const submitted = await dispatchRepositoryReview({
    app: fakeApp(),
    verified_repository: 'octo/example',
    payload: {
      repo_full_name: 'octo/example',
      target_branch: 'main',
      scan_mode: 'incremental',
      base_sha: 'aaaaaaaa',
      head_sha: 'bbbbbbbb',
      event_type: 'manual',
      test_changes: 'deny',
      correlation_id: 'actions-run-1'
    },
    deps: {
      getInstallationOctokit: async (repo_full_name) => {
        assert.strictEqual(repo_full_name, 'octo/example')
        return octokit
      },
      resolve_dispatch: async (args) => {
        assert.strictEqual(args.octokit, octokit)
        assert.strictEqual(args.payload.test_changes, 'deny')
        return resolved
      },
      submit_run: async (args) => {
        submit_calls.push(args)
        const submitted: SubmittedRepositoryReviewRun = {
          repo: {
            owner_login: 'octo',
            repo_name: 'example',
            repo_full_name: 'octo/example',
            default_branch: 'main'
          },
          run_id: 'run-1',
          workspace_ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          scan_target: {
            target_branch: 'main',
            default_branch: 'main',
            event_type: 'manual',
            scan_mode: 'incremental',
            base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            commit_shas: []
          },
          workflow: 'repository-review',
          event_type: 'manual'
        }
        args.on_prepared?.(submitted, {
          contract_version: CONTRACT_VERSION
        } as never)
        return submitted
      },
      store: {
        ...preparationClaim,
        admitReviewRun: (run) => {
          saved_runs.push(withoutPreparationInput(run))
          return {
            record: admittedRecord({ ...run, run_id: 'run-1' }),
            created: true,
            preparation_token: 'claim'
          } as never
        },
        submitPreparedRun: (run_id, _token, context, input) =>
          saved_runs.push({ run_id, context, input }),
        failPreparation: () =>
          assert.fail('successful review must not be marked failed')
      }
    }
  })

  assert.strictEqual(submitted.run_id, 'run-1')
  assert.strictEqual(submit_calls.length, 1)
  const submitCall = submit_calls[0] as Record<string, unknown>
  assert.strictEqual(typeof submitCall.on_prepared, 'function')
  assert.deepStrictEqual(
    {
      octokit: submitCall.octokit,
      run_id: submitCall.run_id,
      repo_full_name: submitCall.repo_full_name,
      target_branch: submitCall.target_branch,
      scan_mode: submitCall.scan_mode,
      base_sha: submitCall.base_sha,
      head_sha: submitCall.head_sha,
      event_type: submitCall.event_type,
      test_changes: submitCall.test_changes,
      correlation_id: submitCall.correlation_id
    },
    {
      octokit,
      run_id: 'run-1',
      ...resolved
    }
  )
  assert.deepStrictEqual(saved_runs[0], {
    workflow: 'repository-review',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:actions-run-1'
  })
  assert.deepStrictEqual(saved_runs[1], {
    run_id: 'run-1',
    input: { contract_version: CONTRACT_VERSION },
    context: {
      repo: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main'
      },
      workspace_ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      scan_target: {
        target_branch: 'main',
        scan_mode: 'incremental',
        base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      },
      event_type: 'manual'
    }
  })
})

test('dispatchRepositoryReview reuses the run admitted for the same repository dispatch', async () => {
  let submissions = 0
  const admissions: unknown[] = []

  const submitted = await dispatchRepositoryReview({
    app: fakeApp(),
    verified_repository: 'octo/example',
    payload: {
      repo_full_name: 'octo/example',
      target_branch: 'main',
      correlation_id: 'actions-run-replayed'
    },
    on_admitted: (admission) => admissions.push(admission),
    deps: {
      getInstallationOctokit: async () => octokitWithRefs(),
      resolve_dispatch: async () => ({
        repo_full_name: 'octo/example',
        target_branch: 'main',
        scan_mode: 'full',
        base_sha: null,
        head_sha: null,
        event_type: 'manual',
        test_changes: null,
        correlation_id: 'actions-run-replayed'
      }),
      submit_run: async () => {
        submissions += 1
        throw new Error('replayed dispatch must not submit another run')
      },
      store: {
        ...preparationClaim,
        admitReviewRun: () => ({
          created: false,
          preparation_token: null,
          record: admittedRecord({ run_id: 'run-original', execution: { status: 'running', started_at: null, finished_at: null, updated_at: '2026-01-01T00:00:00.000Z' } })
        }),
        submitPreparedRun: () =>
          assert.fail('replayed dispatch must not queue again'),
        failPreparation: () =>
          assert.fail('replayed dispatch must not change the original run')
      }
    }
  })

  assert.strictEqual(submitted.run_id, 'run-original')
  assert.strictEqual(submitted.replayed, true)
  assert.strictEqual(submissions, 0)
  assert.deepStrictEqual(admissions, [
    { run_id: 'run-original', status: 'running', replayed: true }
  ])
})

test('dispatchRepositoryReview maps resolver errors to validation errors', async () => {
  const transitions: unknown[] = []
  await assert.rejects(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-invalid-window'
      },
      deps: {
        getInstallationOctokit: async () => ({}) as GitHubAppOctokit,
        resolve_dispatch: async () => {
          throw new Error('manual incremental scan requires base_sha.')
        },
        submit_run: async () => {
          throw new Error('submit_run should not be called')
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            transitions.push(['pending', withoutPreparationInput(run)])
            return {
              record: {
                ...run,
                run_id: 'run-invalid-window',
                execution: { status: 'pending', started_at: null, finished_at: null, updated_at: '2026-01-01T00:00:00.000Z' }
              },
              created: true,
              preparation_token: 'claim'
            } as never
          },
          submitPreparedRun: () =>
            assert.fail('invalid dispatch must not queue a run'),
          failPreparation: (run_id, _token, error) =>
            transitions.push(['failed', run_id, error])
        }
      }
    }),
    (error: unknown) =>
      error instanceof RepositoryReviewDispatchValidationError &&
      error.message === 'manual incremental scan requires base_sha.'
  )
  assert.deepStrictEqual(transitions.at(-1), [
    'failed',
    'run-invalid-window',
    {
      code: 'REVIEW_PREPARATION_FAILED',
      message: 'manual incremental scan requires base_sha.'
    }
  ])
})

test('dispatchRepositoryReview rejects invalid pure contract fields before admission', async () => {
  await assert.rejects(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-invalid-contract',
        scan_mode: 'sometimes'
      },
      deps: {
        getInstallationOctokit: async () =>
          assert.fail('invalid contract must not call GitHub'),
        resolve_dispatch: async () =>
          assert.fail('invalid contract must not resolve refs'),
        submit_run: async () => assert.fail('invalid contract must not submit'),
        store: {
          ...preparationClaim,
          admitReviewRun: () =>
            assert.fail('invalid contract must not create a run'),
          submitPreparedRun: () =>
            assert.fail('invalid contract must not queue'),
          failPreparation: () =>
            assert.fail('invalid contract has no run to fail')
        }
      }
    }),
    (error: unknown) =>
      error instanceof RepositoryReviewDispatchValidationError &&
      /Unsupported repository scan_mode/.test(error.message)
  )
})

test('dispatchRepositoryReview records an accepted run when preparation or submission fails', async () => {
  const transitions: unknown[] = []

  await assert.rejects(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-run-failed'
      },
      deps: {
        getInstallationOctokit: async () => ({}) as GitHubAppOctokit,
        resolve_dispatch: async () => ({
          repo_full_name: 'octo/example',
          target_branch: 'main',
          scan_mode: 'full',
          base_sha: null,
          head_sha: null,
          event_type: 'manual',
          test_changes: 'allow',
          correlation_id: 'actions-run-failed'
        }),
        submit_run: async ({ run_id }) => {
          assert.strictEqual(run_id, 'run-repo-failed')
          throw new Error('bundle preparation failed')
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            transitions.push(['pending', withoutPreparationInput(run)])
            return {
              record: {
                ...run,
                run_id: 'run-repo-failed',
                execution: { status: 'pending', started_at: null, finished_at: null, updated_at: '2026-01-01T00:00:00.000Z' }
              },
              created: true,
              preparation_token: 'claim'
            } as never
          },
          submitPreparedRun: () =>
            assert.fail('failed review must not be queued'),
          failPreparation: (run_id, _token, error) =>
            transitions.push(['failed', run_id, error])
        }
      }
    }),
    /bundle preparation failed/
  )

  assert.deepStrictEqual(transitions, [
    [
      'pending',
      {
        workflow: 'repository-review',
        publish_context: {},
        ingress_kind: 'github_actions_dispatch',
        ingress_key: 'octo/example:actions-run-failed'
      }
    ],
    [
      'failed',
      'run-repo-failed',
      { code: 'REVIEW_START_FAILED', message: 'bundle preparation failed' }
    ]
  ])
})

test('dispatchRepositoryReview preserves an uncertain Runner submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new ControlPlaneSubmissionError(
    'Runner response was lost.',
    'SUBMISSION_STATE_UNCERTAIN'
  )

  await assert.rejects(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-run-uncertain'
      },
      deps: {
        getInstallationOctokit: async () => ({}) as GitHubAppOctokit,
        resolve_dispatch: async () => ({
          repo_full_name: 'octo/example',
          target_branch: 'main',
          scan_mode: 'full',
          base_sha: null,
          head_sha: null,
          event_type: 'manual',
          test_changes: null,
          correlation_id: 'actions-run-uncertain'
        }),
        submit_run: async (args) => {
          args.on_prepared?.(
            {
              repo: {
                owner_login: 'octo',
                repo_name: 'example',
                repo_full_name: 'octo/example',
                default_branch: 'main'
              },
              run_id: 'run-repo-uncertain',
              workspace_ref: 'head-sha',
              scan_target: {
                target_branch: 'main',
                default_branch: 'main',
                event_type: 'manual',
                scan_mode: 'full',
                base_sha: null,
                head_sha: 'head-sha',
                commit_shas: []
              },
              workflow: 'repository-review',
              event_type: 'manual'
            },
            { contract_version: CONTRACT_VERSION } as never
          )
          throw error
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) =>
            ({
              record: {
                ...run,
                run_id: 'run-repo-uncertain',
                execution: { status: 'pending', started_at: null, finished_at: null, updated_at: '2026-01-01T00:00:00.000Z' }
              },
              created: true,
              preparation_token: 'claim'
            }) as never,
          submitPreparedRun: (run_id, _token, context, input) =>
            transitions.push(['prepared', run_id, context, input]),
          failPreparation: (run_id, _token, failure) =>
            transitions.push([run_id, failure])
        }
      }
    }),
    error
  )

  assert.strictEqual((transitions[0] as unknown[])[0], 'prepared')
  assert.strictEqual(transitions.length, 1)
})
function withoutPreparationInput<
  T extends { preparation_input?: unknown; preparation_input_version?: unknown }
>(run: T): Omit<T, 'preparation_input' | 'preparation_input_version'> {
  const rest = { ...run }
  delete rest.preparation_input
  delete rest.preparation_input_version
  return rest
}
