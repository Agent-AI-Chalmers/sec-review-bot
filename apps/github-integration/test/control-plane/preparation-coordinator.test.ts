// Verifies recovery-only preparation inputs can deliver their terminal notice
// without a live webhook payload or a fully materialized pull-request context.
import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareReviewRunsOnce } from '../../src/control-plane/preparation-coordinator.js'

test('terminal preparation notice reaches a pull request reconstructed from pr_reference', async () => {
  const calls: unknown[] = []
  const app = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async (args: unknown) => {
            calls.push(['installation', args])
            return { data: { id: 42 } }
          }
        }
      }
    },
    getInstallationOctokit: async () => ({
      rest: {
        // The reply path verifies a target repository against the installation before writing.
        repos: {
          get: async (args: unknown) => {
            calls.push(['repos.get', args])
            return { data: { full_name: 'octo/example' } }
          }
        },
        issues: {
          listComments: async (args: unknown) => {
            calls.push(['list', args])
            return { data: [] }
          },
          createComment: async (args: unknown) => {
            calls.push(['create', args])
            return {
              data: { id: 9, html_url: 'https://example.test/comment/9' }
            }
          }
        }
      }
    })
  }
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-pr-reference',
      input: {
        kind: 'github_pull_request_review',
        pr_reference: {
          owner_login: 'octo',
          repo_name: 'example',
          pr_number: 7
        }
      },
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app: app as never, store: store as never }),
    true
  )
  assert.deepStrictEqual(calls.slice(0, 3), [
    ['installation', { owner: 'octo', repo: 'example' }],
    ['repos.get', { owner: 'octo', repo: 'example' }],
    [
      'list',
      {
        owner: 'octo',
        repo: 'example',
        issue_number: 7,
        per_page: 100,
        page: 1
      }
    ]
  ])
  const create = calls[3] as ['create', { body: string }]
  assert.match(create[1].body, /run-pr-reference/)
  assert.deepStrictEqual(completed, [
    // The comment that was posted, so the console can link the requester to it.
    ['run-pr-reference', 'notice-token', true, 'https://example.test/comment/9']
  ])
})

test('preparation-first scheduling falls back to a terminal notice when no preparation is ready', async () => {
  const calls: string[] = []
  const store = {
    claimNextPreparation: async () => {
      calls.push('preparation')
      return null
    },
    claimNextRunFailureNotice: async () => {
      calls.push('notice')
      return {
        run_id: 'run-without-reply-target',
        input: {},
        failure_code: 'PREPARATION_RETRY_EXHAUSTED',
        claim_token: 'notice-claim'
      }
    },
    completeRunFailureNotice: async () => {
      calls.push('complete-notice')
      return true
    }
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({
      app: {} as never,
      store: store as never,
      preferFailureNotice: false
    }),
    true
  )
  assert.deepStrictEqual(calls, ['preparation', 'notice', 'complete-notice'])
})

test('a repository scan failure reports into the repository summary issue', async () => {
  // A repository scan has no conversation to reply in: it is dispatched from GitHub Actions or
  // a schedule. Its success path reports into the repository's summary issue, so a failure has
  // to be readable in the same place; otherwise whoever started the scan sees nothing, and the
  // outcome exists only inside the Control Plane.
  const calls: Array<[string, unknown]> = []
  const app = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async (args: unknown) => {
            calls.push(['installation', args])
            return { data: { id: 42 } }
          }
        }
      }
    },
    getInstallationOctokit: async () => ({
      rest: {
        // The reply path verifies the target repository against the installation before writing.
        repos: {
          get: async (args: unknown) => {
            calls.push(['repos.get', args])
            return { data: { full_name: 'octo/example' } }
          }
        },
        issues: {
          listForRepo: async (args: unknown) => {
            calls.push(['list-for-repo', args])
            return {
              data: [
                {
                  number: 77,
                  title: '[sec-review-bot] Repository Security Review Summary'
                }
              ]
            }
          },
          listComments: async (args: unknown) => {
            calls.push(['list-comments', args])
            return { data: [] }
          },
          createComment: async (args: unknown) => {
            calls.push(['create-comment', args])
            return {
              data: { id: 5, html_url: 'https://example.test/comment/5' }
            }
          }
        }
      }
    })
  }
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-repository',
      input: {
        kind: 'github_repository_review',
        payload: { repo_full_name: 'octo/example' },
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app: app as never, store: store as never }),
    true
  )
  const created = calls.find(([kind]) => kind === 'create-comment')
  assert.ok(created, 'the failure must be posted as a comment')
  const body = created[1] as { body: string; issue_number: number }
  assert.strictEqual(
    body.issue_number,
    77,
    'it reports into the existing summary issue, not a new one'
  )
  assert.match(body.body, /run-repository/)
  assert.match(body.body, /PREPARATION_RETRY_EXHAUSTED/)
  assert.deepStrictEqual(completed, [
    ['run-repository', 'notice-token', true, 'https://example.test/comment/5']
  ])
})

test('an unrecoverable notice concludes instead of being retried forever', async () => {
  // A notice is re-claimed whenever its delivery lease expires, so a fault that retrying cannot
  // repair would otherwise be attempted again on every lease period, forever, while the
  // requester is never told and the run never settles. A 404 for the repository's installation is
  // exactly that: the App will never gain access by waiting. It must be concluded as undelivered
  // so the record reflects what happened.
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-unreachable-repository',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }
  const app = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async () => {
            throw Object.assign(new Error('Not Found'), { status: 404 })
          }
        }
      }
    },
    getInstallationOctokit: async () => {
      throw new Error('unused: the installation lookup already failed')
    }
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app: app as never, store: store as never }),
    true
  )
  assert.deepStrictEqual(
    completed,
    [
      // No comment URL: nothing was posted, and the notice says so instead of staying open.
      ['run-unreachable-repository', 'notice-token', false]
    ],
    'an unrecoverable notice is concluded, not left claimable'
  )
})

test('a transient notice failure stays claimable for another attempt', async () => {
  // The opposite case: a 5xx or a dropped connection is worth retrying, so the notice must keep
  // its claim and be picked up again when the lease expires. Concluding it here would lose the
  // outcome the requester still has no way to read.
  const completed: unknown[] = []
  const store = {
    claimNextRunFailureNotice: async () => ({
      run_id: 'run-transient',
      input: {
        kind: 'github_repository_review',
        verified_repository: 'octo/example'
      },
      failure_stage: 'preparation',
      failure_code: 'PREPARATION_RETRY_EXHAUSTED',
      claim_token: 'notice-token'
    }),
    completeRunFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }
  const app = {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: async () => {
            throw Object.assign(new Error('Server Error'), { status: 503 })
          }
        }
      }
    },
    getInstallationOctokit: async () => {
      throw new Error('unused: the installation lookup already failed')
    }
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app: app as never, store: store as never }),
    true
  )
  assert.deepStrictEqual(
    completed,
    [],
    'a transient failure leaves the notice claimed for the next lease'
  )
})
