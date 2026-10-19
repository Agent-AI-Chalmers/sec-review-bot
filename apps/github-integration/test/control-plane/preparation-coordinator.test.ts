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
    claimNextPreparationFailureNotice: async () => ({
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
    completePreparationFailureNotice: async (...args: unknown[]) => {
      completed.push(args)
      return true
    },
    claimNextPreparation: async () => assert.fail('notice takes priority')
  }

  assert.strictEqual(
    await prepareReviewRunsOnce({ app: app as never, store: store as never }),
    true
  )
  assert.deepStrictEqual(calls.slice(0, 2), [
    ['installation', { owner: 'octo', repo: 'example' }],
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
  const create = calls[2] as ['create', { body: string }]
  assert.match(create[1].body, /run-pr-reference/)
  assert.deepStrictEqual(completed, [
    ['run-pr-reference', 'notice-token', true]
  ])
})

test('preparation-first scheduling falls back to a terminal notice when no preparation is ready', async () => {
  const calls: string[] = []
  const store = {
    claimNextPreparation: async () => {
      calls.push('preparation')
      return null
    },
    claimNextPreparationFailureNotice: async () => {
      calls.push('notice')
      return {
        run_id: 'run-without-reply-target',
        input: {},
        failure_code: 'PREPARATION_RETRY_EXHAUSTED',
        claim_token: 'notice-claim'
      }
    },
    completePreparationFailureNotice: async () => {
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
