import { publishedInputBundleReference } from '../../src/artifacts/input-storage.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inputBundlePublicationStore } from '../input-bundle-publication-store.js'
// Covers repository-dispatch admission, preparation, and submission boundaries
// with controlled connector and Review Runs dependencies.
import { expect, afterAll, test } from 'vitest'
import type { App } from 'octokit'

import { fakeApp as fakeGitHubApp } from '../github-app-stubs.js'
import {
  dispatchRepositoryReview,
  resolveRepositoryReviewDispatch,
  RepositoryReviewDispatchValidationError
} from '../../src/triggers/repository-review.js'
import type { Octokit } from 'octokit'
import { ReviewRunsSubmissionError } from '../../src/review-runs/client.js'
import type {
  ReviewRunAdmission,
  ReviewRunRecord
} from '../../src/review-runs/client.js'
import { EXECUTION_API_VERSION } from '../../src/execution/execution-api-version.js'
import type { RepositoryReviewInput } from '../../src/execution/input.js'
import type { PreparedRepositoryReviewRun } from '../../src/reviews/repositories/prepare-review.js'
import { fakeGitHub, githubJson, unusedGitHub } from '../github-client.js'

/** An admitted run record as Review Runs returns it, with the axis shapes spelled once.
 *
 * The tests below stub `admitReviewRun`, and each stub used to write out the whole record shape
 * and then cast it with `as never`. That cast switched off every check on the shape, so a field
 * added to the contract (or moved between axes) left these stubs compiling while returning
 * something the real service never would. Building the record here keeps one definition and
 * lets the `ReviewRunRecord` type police it.
 */

const bundleRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'repository-trigger-input-')
)
const bundlePath = path.join(bundleRoot, 'bundle.tar.zst')
await fs.writeFile(bundlePath, 'x')
afterAll(() => fs.rm(bundleRoot, { recursive: true, force: true }))

/** A complete `RepositoryReviewInput`, returned by preparation. */
function repositoryReviewInput(): RepositoryReviewInput &
  Record<string, unknown> {
  return {
    api_version: EXECUTION_API_VERSION,
    input_bundle: {
      uri: pathToFileURL(bundlePath).href,
      digest: `sha256:${createHash('sha256').update('x').digest('hex')}`,
      media_type: 'application/tar+zstd',
      size_bytes: 1
    },
    review_intent: { objective: 'audit' },
    scan_target: {
      target_branch: 'main',
      default_branch: 'main',
      event_type: 'manual',
      scan_mode: 'full',
      base_sha: null,
      head_sha: 'head-sha',
      commit_shas: []
    },
    scan_scope: { paths_ignore: [], incremental_changed_files: [] }
  } satisfies RepositoryReviewInput
}

function admittedRecord(
  overrides: Partial<ReviewRunRecord> & { run_id: string }
): ReviewRunRecord {
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

const preparationClaim = {
  ...inputBundlePublicationStore(),
  renewPreparationClaim: async () => true,
  preparationHeartbeatIntervalMs: async () => 60_000
}

function fakeApp(): App {
  // Every test below injects `deps.getInstallationOctokit`, so the App only has to answer the
  // installation *lookup*; the client it would otherwise hand back is never reached.
  return fakeGitHubApp({
    respond: ({ url }) => {
      const match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(
        new URL(url).pathname
      )
      if (!match) return githubJson({ message: 'Not Found' }, 404)
      return githubJson({ id: 123 })
    }
  }).app
}

function octokitWithRefs(): Octokit {
  return fakeGitHub(({ url }) => {
    const pathname = new URL(url).pathname
    if (pathname.includes('/branches/')) {
      const branch = decodeURIComponent(pathname.split('/branches/')[1] ?? '')
      // Only `main` is a branch; anything else is a real 404 from GitHub.
      if (branch !== 'main') return githubJson({ message: 'Not Found' }, 404)
      return githubJson({
        commit: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      })
    }
    if (pathname.includes('/commits/')) {
      const ref = decodeURIComponent(pathname.split('/commits/')[1] ?? '')
      return githubJson({
        sha:
          ref === 'aaaaaaaa'
            ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            : ref === 'cccccccc'
              ? 'cccccccccccccccccccccccccccccccccccccccc'
              : ref
      })
    }
    if (pathname.endsWith('/commits')) {
      return githubJson([
        {
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          commit: { message: 'base', author: { date: '2026-05-24T00:00:00Z' } }
        }
      ])
    }
    return githubJson({})
  }).octokit
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

  expect(resolved.scan_mode).toBe('incremental')
  expect(resolved.event_type).toBe('scheduled')
  expect(resolved.target_branch).toBe('main')
  expect(resolved.head_sha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  expect(resolved.base_sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
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

  expect(resolved.scan_mode).toBe('incremental')
  expect(resolved.event_type).toBe('manual')
  expect(resolved.base_sha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  expect(resolved.head_sha).toBe('cccccccccccccccccccccccccccccccccccccccc')
  expect(resolved.test_changes).toBe('deny')
})

test('dispatchRepositoryReview resolves, submits, and persists a queued repository review run', async () => {
  const { octokit } = unusedGitHub()
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
        expect(repo_full_name).toBe('octo/example')
        return octokit
      },
      resolve_dispatch: async (args) => {
        expect(args.octokit).toBe(octokit)
        expect(args.payload.test_changes).toBe('deny')
        return resolved
      },
      prepare_review: async (args) => {
        submit_calls.push(args)
        const submitted: PreparedRepositoryReviewRun = {
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
        return { review: submitted, input: repositoryReviewInput() }
      },
      store: {
        ...preparationClaim,
        admitReviewRun: (run) => {
          saved_runs.push(withoutPreparationInput(run))
          return {
            record: admittedRecord({ ...run, run_id: 'run-1' }),
            created: true,
            preparation_token: 'claim'
          } satisfies ReviewRunAdmission
        },
        submitPreparedRun: (run_id, _token, context, input) =>
          saved_runs.push({ run_id, context, input }),
        failPreparation: () =>
          expect.unreachable('successful review must not be marked failed')
      }
    }
  })

  expect(submitted.run_id).toBe('run-1')
  expect(submit_calls.length).toBe(1)
  const submitCall = submit_calls[0] as Record<string, unknown>
  expect({
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
  }).toStrictEqual({
    octokit,
    run_id: 'run-1',
    ...resolved
  })
  expect(saved_runs[0]).toStrictEqual({
    workflow: 'repository-review',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:actions-run-1'
  })
  expect(saved_runs[1]).toStrictEqual({
    run_id: 'run-1',
    input: {
      ...repositoryReviewInput(),
      input_bundle: publishedInputBundleReference(
        repositoryReviewInput().input_bundle,
        'run-1'
      )
    },
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
      prepare_review: async () => {
        submissions += 1
        throw new Error('replayed dispatch must not submit another run')
      },
      store: {
        ...preparationClaim,
        admitReviewRun: () => ({
          created: false,
          preparation_token: null,
          record: admittedRecord({
            run_id: 'run-original',
            execution: {
              status: 'running',
              started_at: null,
              finished_at: null,
              updated_at: '2026-01-01T00:00:00.000Z'
            }
          })
        }),
        submitPreparedRun: () =>
          expect.unreachable('replayed dispatch must not queue again'),
        failPreparation: () =>
          expect.unreachable(
            'replayed dispatch must not change the original run'
          )
      }
    }
  })

  expect(submitted.run_id).toBe('run-original')
  expect(submitted.replayed).toBe(true)
  expect(submissions).toBe(0)
  expect(admissions).toStrictEqual([
    { run_id: 'run-original', status: 'running', replayed: true }
  ])
})

test('dispatchRepositoryReview maps resolver errors to validation errors', async () => {
  const transitions: unknown[] = []
  await expect(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-invalid-window'
      },
      deps: {
        getInstallationOctokit: async () => unusedGitHub().octokit,
        resolve_dispatch: async () => {
          throw new Error('manual incremental scan requires base_sha.')
        },
        prepare_review: async () => {
          throw new Error('prepare_review should not be called')
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            transitions.push(['pending', withoutPreparationInput(run)])
            return {
              record: admittedRecord({ ...run, run_id: 'run-invalid-window' }),
              created: true,
              preparation_token: 'claim'
            } satisfies ReviewRunAdmission
          },
          submitPreparedRun: () =>
            expect.unreachable('invalid dispatch must not queue a run'),
          failPreparation: (run_id, _token, error) =>
            transitions.push(['failed', run_id, error])
        }
      }
    })
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof RepositoryReviewDispatchValidationError &&
      error.message === 'manual incremental scan requires base_sha.'
  )
  expect(transitions.at(-1)).toStrictEqual([
    'failed',
    'run-invalid-window',
    {
      code: 'REVIEW_PREPARATION_FAILED',
      message: 'manual incremental scan requires base_sha.'
    }
  ])
})

test('dispatchRepositoryReview rejects invalid pure contract fields before admission', async () => {
  await expect(
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
          expect.unreachable('invalid contract must not call GitHub'),
        resolve_dispatch: async () =>
          expect.unreachable('invalid contract must not resolve refs'),
        prepare_review: async () =>
          expect.unreachable('invalid contract must not submit'),
        store: {
          ...preparationClaim,
          admitReviewRun: () =>
            expect.unreachable('invalid contract must not create a run'),
          submitPreparedRun: () =>
            expect.unreachable('invalid contract must not queue'),
          failPreparation: () =>
            expect.unreachable('invalid contract has no run to fail')
        }
      }
    })
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof RepositoryReviewDispatchValidationError &&
      /Unsupported repository scan_mode/.test(error.message)
  )
})

test('dispatchRepositoryReview records an accepted run when preparation or submission fails', async () => {
  const transitions: unknown[] = []

  await expect(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-run-failed'
      },
      deps: {
        getInstallationOctokit: async () => unusedGitHub().octokit,
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
        prepare_review: async ({ run_id }) => {
          expect(run_id).toBe('run-repo-failed')
          throw new Error('bundle preparation failed')
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) => {
            transitions.push(['pending', withoutPreparationInput(run)])
            return {
              record: admittedRecord({ ...run, run_id: 'run-repo-failed' }),
              created: true,
              preparation_token: 'claim'
            } satisfies ReviewRunAdmission
          },
          submitPreparedRun: () =>
            expect.unreachable('failed review must not be queued'),
          failPreparation: (run_id, _token, error) =>
            transitions.push(['failed', run_id, error])
        }
      }
    })
  ).rejects.toThrow(/bundle preparation failed/)

  expect(transitions).toStrictEqual([
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

test('dispatchRepositoryReview preserves an uncertain Execution submission for replay', async () => {
  const transitions: unknown[] = []
  const error = new ReviewRunsSubmissionError(
    'Execution response was lost.',
    'SUBMISSION_STATE_UNCERTAIN'
  )

  await expect(
    dispatchRepositoryReview({
      app: fakeApp(),
      verified_repository: 'octo/example',
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        correlation_id: 'actions-run-uncertain'
      },
      deps: {
        getInstallationOctokit: async () => unusedGitHub().octokit,
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
        prepare_review: async () => {
          return {
            review: {
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
            input: repositoryReviewInput()
          }
        },
        store: {
          ...preparationClaim,
          admitReviewRun: (run) =>
            ({
              record: admittedRecord({ ...run, run_id: 'run-repo-uncertain' }),
              created: true,
              preparation_token: 'claim'
            }) satisfies ReviewRunAdmission,
          submitPreparedRun: (run_id, _token, context, input) => {
            transitions.push(['prepared', run_id, context, input])
            throw error
          },
          failPreparation: (run_id, _token, failure) =>
            transitions.push([run_id, failure])
        }
      }
    })
  ).rejects.toMatchObject({
    ...error,
    name: error.name,
    message: error.message
  })

  expect((transitions[0] as unknown[])[0]).toBe('prepared')
  expect(transitions.length).toBe(1)
})

function withoutPreparationInput<
  T extends { preparation_input?: unknown; preparation_input_version?: unknown }
>(run: T): Omit<T, 'preparation_input' | 'preparation_input_version'> {
  const rest = { ...run }
  delete rest.preparation_input
  delete rest.preparation_input_version
  return rest
}

test('recovery transport failure retries preparation without rebuilding GitHub input', async () => {
  const error = new Error('storage unavailable')
  const failures: unknown[] = []
  await expect(
    dispatchRepositoryReview({
      app: fakeApp(),
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main',
        scan_mode: 'full',
        event_type: 'manual',
        correlation_id: 'recover'
      },
      verified_repository: 'octo/example',
      claimed_preparation: { run_id: 'recover-run', token: 'current' },
      deps: {
        getInstallationOctokit: async () =>
          expect.unreachable('must reconcile before fetching GitHub'),
        store: {
          ...preparationClaim,
          admitReviewRun: () => expect.unreachable('already admitted'),
          async listInputBundleCandidates() {
            throw error
          },
          submitPreparedRun: () =>
            expect.unreachable('unconfirmed input must not submit'),
          failPreparation: (_run, _token, _failure, options) => {
            failures.push(options)
          }
        }
      }
    })
  ).rejects.toSatisfy(
    (caught) =>
      caught instanceof RepositoryReviewDispatchValidationError &&
      caught.message === error.message
  )
  expect((failures[0] as { retry: boolean }).retry).toBe(true)
})
