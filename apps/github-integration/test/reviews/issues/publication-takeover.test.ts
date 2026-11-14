import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { handleIssueReviewRun } from '../../../src/reviews/issues/publish.js'
import { setGitHubAppMetadata } from '../../../src/github/github-app-metadata-service.js'
import { PublicationClaimLostError } from '../../../src/review-runs/publication-claim.js'
import type {
  PublicationStepRecord,
  PublicationStepStore
} from '../../../src/review-runs/client.js'
import { fakeGitHub, githubJson } from '../../github-client.js'

for (const pauseAt of ['comment lookup', 'accepted comment'] as const) {
  test(`publication takeover recovers while the old owner is paused at ${pauseAt}`, async () => {
    // The connector owns GitHub effects; model only its HTTP store boundary here.
    let owner = 'first'
    let step: PublicationStepRecord | undefined
    const reviewRunsClient: PublicationStepStore & {
      renewPublicationClaim(runId: string, token: string): Promise<boolean>
    } = {
      initializePublicationSteps: async (_runId, token, keys) => {
        if (token !== owner) throw new PublicationClaimLostError('run')
        assert.deepEqual(keys, ['issue:summary-comment'])
        step ??= {
          step_key: keys[0]!,
          status: 'pending',
          attempt_count: 0,
          last_attempt_at: null,
          remote_object_id: null,
          remote_object_url: null,
          failure_code: null,
          failure_message: null
        }
      },
      listPublicationSteps: async () => (step ? [step] : []),
      requirePublicationStepClaim: async (_runId, token) => {
        if (token !== owner) throw new PublicationClaimLostError('run')
      },
      completePublicationStep: async (_runId, token, _key, remote) => {
        if (token !== owner) return false
        assert(step)
        step.status = 'succeeded'
        assert(remote)
        step.remote_object_id = String(remote.id)
        return true
      },
      failPublicationStep: async (_runId, token) => {
        if (token !== owner) return false
        assert(step)
        step.status = 'failed'
        return true
      },
      settleExhaustedPublicationStep: async () => {
        throw new Error('unexpected exhaustion')
      },
      renewPublicationClaim: async (_runId, token) => token === owner
    }
    setGitHubAppMetadata({
      id: 1,
      slug: 'sec-review-bot',
      name: 'Sec Review Bot'
    })
    const runId = randomUUID()
    const context = {
      issue: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main',
        issue_number: 7,
        issue_title: 'Example'
      },
      workspace_ref: 'workspace-sha',
      event_type: 'manual_review',
      open_pr: false
    }
    const result: unknown = JSON.parse(
      await readFile(
        new URL(
          '../../../../../contracts/execution-api/v1/fixtures/issue-review-result.json',
          import.meta.url
        ),
        'utf8'
      )
    )
    const firstToken = owner

    const paused = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let pauseOnce = true
    let posts = 0
    const comments: Array<{
      id: number
      html_url: string
      body: string
      user: { login: string; type: string }
    }> = []
    const { octokit } = fakeGitHub(async ({ method, url, body }) => {
      assert(
        new URL(url).pathname.endsWith('/comments'),
        `unexpected GitHub request: ${method} ${url}`
      )
      if (method === 'GET') {
        const snapshot = [...comments]
        if (pauseAt === 'comment lookup' && pauseOnce) {
          pauseOnce = false
          paused.resolve()
          await release.promise
        }
        return githubJson(snapshot)
      }
      assert.equal(method, 'POST')
      posts += 1
      assert(
        body &&
          typeof body === 'object' &&
          'body' in body &&
          typeof body.body === 'string'
      )
      const comment = {
        id: posts,
        html_url: `https://example.test/comments/${posts}`,
        body: body.body,
        user: { login: 'sec-review-bot[bot]', type: 'Bot' }
      }
      comments.push(comment)
      if (pauseAt === 'accepted comment' && pauseOnce) {
        pauseOnce = false
        paused.resolve()
        await release.promise
        throw new Error('response lost after GitHub accepted the comment')
      }
      return githubJson(comment)
    })
    const publish = (token: string) =>
      handleIssueReviewRun({
        run: { run_id: runId, publish_context: context },
        result,
        store: reviewRunsClient,
        claim_token: token,
        assert_publication_claim: async () => {
          if (!(await reviewRunsClient.renewPublicationClaim(runId, token)))
            throw new PublicationClaimLostError(runId)
        },
        installation_octokit_for_repo: async () => octokit
      })
    const oldAttempt = publish(firstToken)
    const oldRejected = assert.rejects(
      oldAttempt,
      pauseAt === 'comment lookup' ? PublicationClaimLostError : /response lost/
    )
    try {
      await Promise.race([
        paused.promise,
        oldAttempt.then(() => {
          throw new Error('publisher finished before the injected pause')
        })
      ])
      owner = 'next'
      const nextToken = owner
      await publish(nextToken)
      release.resolve()
      await oldRejected
      assert.equal(
        await reviewRunsClient.renewPublicationClaim(runId, firstToken),
        false
      )
      assert.equal(posts, 1)
      assert.equal(comments.length, 1)
      assert.equal(step?.status, 'succeeded')
      assert.equal(step?.remote_object_id, String(comments[0]?.id))
    } finally {
      release.resolve()
      await oldRejected
    }
  })
}
