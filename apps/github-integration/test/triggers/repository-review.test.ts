import assert from 'node:assert/strict'
import test from 'node:test'
import type { App } from 'octokit'

import { appWithInstallationOctokit } from '../github-app-stubs.js'
import {
  dispatchRepositoryReview,
  resolveRepositoryReviewDispatch,
  RepositoryReviewDispatchValidationError
} from '../../triggers/repository-review.js'
import type { GitHubAppOctokit } from '../../infrastructure/github/octokit.js'
import { RunnerSubmissionUncertainError } from '../../infrastructure/runner/client.js'
import type { SubmittedRepositoryReviewRun } from '../../reviews/repositories/submit.js'

function fakeApp (): App {
  return appWithInstallationOctokit({
    installation_octokit: { installation_id: 123 } as unknown as GitHubAppOctokit,
    expected_owner: 'octo',
    expected_repo: 'example'
  })
}

function octokitWithRefs (): GitHubAppOctokit {
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
            sha: ref === 'aaaaaaaa'
              ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
              : ref === 'cccccccc'
                ? 'cccccccccccccccccccccccccccccccccccccccc'
                : String(ref)
          }
        }),
        listCommits: async () => ({
          data: [{
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            commit: {
              message: 'base',
              author: {
                date: '2026-05-24T00:00:00Z'
              }
            }
          }]
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

  assert.equal(resolved.scan_mode, 'incremental')
  assert.equal(resolved.event_type, 'scheduled')
  assert.equal(resolved.target_branch, 'main')
  assert.equal(resolved.head_sha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(resolved.base_sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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
      repair_mode: 'no-test-changes',
      correlation_id: 'manual-run-1'
    }
  })

  assert.equal(resolved.scan_mode, 'incremental')
  assert.equal(resolved.event_type, 'manual')
  assert.equal(resolved.base_sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(resolved.head_sha, 'cccccccccccccccccccccccccccccccccccccccc')
  assert.equal(resolved.repair_mode, 'no-test-changes')
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
    repair_mode: 'no-test-changes' as const,
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
      repair_mode: 'no-test-changes',
      correlation_id: 'actions-run-1'
    },
    deps: {
      getInstallationOctokit: async (repo_full_name) => {
        assert.equal(repo_full_name, 'octo/example')
        return octokit
      },
      resolve_dispatch: async (args) => {
        assert.equal(args.octokit, octokit)
        assert.equal(args.payload.repair_mode, 'no-test-changes')
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
        args.on_prepared?.(submitted, { contract_version: 'v4' } as never)
        return submitted
      },
      create_run_id: () => 'run-1',
      store: {
        admit_review_run: (run) => {
          saved_runs.push(run)
          return { record: { ...run, status: 'preparing' }, created: true } as never
        },
        save_prepared_submission: (run_id, context, input) => saved_runs.push({ run_id, context, input }),
        mark_queued: () => {},
        markFailed: () => assert.fail('successful review must not be marked failed')
      }
    }
  })

  assert.equal(submitted.run_id, 'run-1')
  assert.equal(submit_calls.length, 1)
  const submitCall = submit_calls[0] as Record<string, unknown>
  assert.equal(typeof submitCall.on_prepared, 'function')
  assert.deepEqual({
    octokit: submitCall.octokit,
    run_id: submitCall.run_id,
    repo_full_name: submitCall.repo_full_name,
    target_branch: submitCall.target_branch,
    scan_mode: submitCall.scan_mode,
    base_sha: submitCall.base_sha,
    head_sha: submitCall.head_sha,
    event_type: submitCall.event_type,
    repair_mode: submitCall.repair_mode,
    correlation_id: submitCall.correlation_id
  }, {
    octokit,
    run_id: 'run-1',
    ...resolved
  })
  assert.deepEqual(saved_runs[0], {
    workflow: 'repository-review',
    run_id: 'run-1',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:actions-run-1'
  })
  assert.deepEqual(saved_runs[1], {
    run_id: 'run-1',
    input: { contract_version: 'v4' },
    context: {
      repo: {
        owner_login: 'octo', repo_name: 'example', repo_full_name: 'octo/example', default_branch: 'main'
      },
      workspace_ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      scan_target: {
        target_branch: 'main', default_branch: 'main', event_type: 'manual', scan_mode: 'incremental',
        base_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', commit_shas: []
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
        repair_mode: null,
        correlation_id: 'actions-run-replayed'
      }),
      create_run_id: () => 'run-unused',
      submit_run: async () => {
        submissions += 1
        throw new Error('replayed dispatch must not submit another run')
      },
      store: {
        admit_review_run: () => ({
          created: false,
          record: { run_id: 'run-original', status: 'running' } as never
        }),
        mark_queued: () => assert.fail('replayed dispatch must not queue again'),
        markFailed: () => assert.fail('replayed dispatch must not change the original run')
      }
    }
  })

  assert.equal(submitted.run_id, 'run-original')
  assert.equal(submitted.replayed, true)
  assert.equal(submissions, 0)
  assert.deepEqual(admissions, [{ run_id: 'run-original', status: 'running', replayed: true }])
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
        create_run_id: () => 'run-invalid-window',
        getInstallationOctokit: async () => ({}) as GitHubAppOctokit,
        resolve_dispatch: async () => {
          throw new Error('manual incremental scan requires base_sha.')
        },
        submit_run: async () => {
          throw new Error('submit_run should not be called')
        },
        store: {
          admit_review_run: (run) => {
            transitions.push(['preparing', run])
            return { record: { ...run, status: 'preparing' }, created: true } as never
          },
          mark_queued: () => assert.fail('invalid dispatch must not queue a run'),
          markFailed: (run_id, error) => transitions.push(['failed', run_id, error])
        }
      }
    }),
    (error: unknown) => error instanceof RepositoryReviewDispatchValidationError &&
      error.message === 'manual incremental scan requires base_sha.'
  )
  assert.deepEqual(transitions.at(-1), [
    'failed',
    'run-invalid-window',
    { code: 'REVIEW_PREPARATION_FAILED', message: 'manual incremental scan requires base_sha.' }
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
        getInstallationOctokit: async () => assert.fail('invalid contract must not call GitHub'),
        resolve_dispatch: async () => assert.fail('invalid contract must not resolve refs'),
        submit_run: async () => assert.fail('invalid contract must not submit'),
        store: {
          admit_review_run: () => assert.fail('invalid contract must not create a run'),
          mark_queued: () => assert.fail('invalid contract must not queue'),
          markFailed: () => assert.fail('invalid contract has no run to fail')
        }
      }
    }),
    (error: unknown) => error instanceof RepositoryReviewDispatchValidationError &&
      /Unsupported repository scan_mode/.test(error.message)
  )
})

test('dispatchRepositoryReview records an accepted run when preparation or submission fails', async () => {
  const transitions: unknown[] = []

  await assert.rejects(
    dispatchRepositoryReview({
      app: fakeApp(),
    verified_repository: 'octo/example',
      payload: { repo_full_name: 'octo/example', target_branch: 'main', correlation_id: 'actions-run-failed' },
      deps: {
        getInstallationOctokit: async () => ({}) as GitHubAppOctokit,
        resolve_dispatch: async () => ({
          repo_full_name: 'octo/example',
          target_branch: 'main',
          scan_mode: 'full',
          base_sha: null,
          head_sha: null,
          event_type: 'manual',
          repair_mode: 'test-changes-allowed',
          correlation_id: 'actions-run-failed'
        }),
        create_run_id: () => 'run-repo-failed',
        submit_run: async ({ run_id }) => {
          assert.equal(run_id, 'run-repo-failed')
          throw new Error('bundle preparation failed')
        },
        store: {
          admit_review_run: (run) => {
            transitions.push(['preparing', run])
            return { record: { ...run, status: 'preparing' }, created: true } as never
          },
          mark_queued: () => assert.fail('failed review must not be queued'),
          markFailed: (run_id, error) => transitions.push(['failed', run_id, error])
        }
      }
    }),
    /bundle preparation failed/
  )

  assert.deepEqual(transitions, [
    ['preparing', {
      workflow: 'repository-review',
      run_id: 'run-repo-failed',
      publish_context: {},
      ingress_kind: 'github_actions_dispatch',
      ingress_key: 'octo/example:actions-run-failed'
    }],
    ['failed', 'run-repo-failed', { code: 'REVIEW_START_FAILED', message: 'bundle preparation failed' }]
  ])
})

test('dispatchRepositoryReview preserves an uncertain Runner submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new RunnerSubmissionUncertainError('Runner response was lost.')

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
          repair_mode: null,
          correlation_id: 'actions-run-uncertain'
        }),
        create_run_id: () => 'run-repo-uncertain',
        submit_run: async (args) => {
          args.on_prepared?.({
            repo: { owner_login: 'octo', repo_name: 'example', repo_full_name: 'octo/example', default_branch: 'main' },
            run_id: 'run-repo-uncertain',
            workspace_ref: 'head-sha',
            scan_target: { target_branch: 'main', default_branch: 'main', event_type: 'manual', scan_mode: 'full', base_sha: null, head_sha: 'head-sha', commit_shas: [] },
            workflow: 'repository-review',
            event_type: 'manual'
          }, { contract_version: 'v4' } as never)
          throw error
        },
        store: {
          admit_review_run: (run) => ({ record: { ...run, status: 'preparing' }, created: true }) as never,
          save_prepared_submission: (run_id, context, input) => transitions.push(['prepared', run_id, context, input]),
          mark_queued: () => assert.fail('uncertain submission must not queue yet'),
          markFailed: (run_id, failure) => transitions.push([run_id, failure])
        }
      }
    }),
    error
  )

  assert.equal((transitions[0] as unknown[])[0], 'prepared')
  assert.deepEqual(transitions[1], [
    'run-repo-uncertain',
    { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'Runner response was lost.' }
  ])
})
