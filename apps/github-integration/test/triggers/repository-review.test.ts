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
      schedule: '0 3 * * 1'
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
      repair_mode: 'no-test-changes'
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
    repair_mode: 'no-test-changes' as const
  }

  const submitted = await dispatchRepositoryReview({
    app: fakeApp(),
    payload: {
      repo_full_name: 'octo/example',
      target_branch: 'main',
      scan_mode: 'incremental',
      base_sha: 'aaaaaaaa',
      head_sha: 'bbbbbbbb',
      event_type: 'manual',
      repair_mode: 'no-test-changes'
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
        return {
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
      },
      store: {
        save_queued_run: (run) => {
          saved_runs.push(run)
          return run as never
        }
      }
    }
  })

  assert.equal(submitted.run_id, 'run-1')
  assert.deepEqual(submit_calls, [{
    octokit,
    ...resolved
  }])
  assert.deepEqual(saved_runs, [{
    workflow: 'repository-review',
    run_id: 'run-1',
    publish_context: {
      repo: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main'
      },
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
      event_type: 'manual'
    }
  }])
})

test('dispatchRepositoryReview maps resolver errors to validation errors', async () => {
  await assert.rejects(
    dispatchRepositoryReview({
      app: fakeApp(),
      payload: {
        repo_full_name: 'octo/example',
        target_branch: 'main'
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
          save_queued_run: () => {
            throw new Error('save_queued_run should not be called')
          }
        }
      }
    }),
    (error: unknown) => error instanceof RepositoryReviewDispatchValidationError &&
      error.message === 'manual incremental scan requires base_sha.'
  )
})
