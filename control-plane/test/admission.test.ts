import assert from 'node:assert/strict'
import test from 'node:test'

import { admitReviewRun } from '../src/index.js'

test('admission assigns a run identity before preparation', async () => {
  let persisted
  const admission = await admitReviewRun(
    {
      async admit_review_run(run) {
        persisted = run
        return {
          record: { ...run, status: 'preparing' },
          created: true,
          preparation_token: 'claim-1'
        }
      }
    },
    {
      workflow: 'pull-request-review',
      ingress_kind: 'github_webhook',
      ingress_key: 'delivery-1'
    },
    () => 'run-1'
  )

  assert.deepEqual(persisted, {
    run_id: 'run-1',
    workflow: 'pull-request-review',
    publish_context: {},
    ingress_kind: 'github_webhook',
    ingress_key: 'delivery-1'
  })
  assert.deepEqual(admission, {
    run_id: 'run-1',
    workflow: 'pull-request-review',
    status: 'preparing',
    created: true,
    preparation_token: 'claim-1'
  })
})

test('an ingress replay keeps the identity returned by durable admission', async () => {
  const admission = await admitReviewRun(
    {
      async admit_review_run() {
        return {
          record: {
            run_id: 'original-run',
            workflow: 'issue-review',
            status: 'failed'
          },
          created: false,
          preparation_token: null
        }
      }
    },
    {
      workflow: 'issue-review',
      ingress_kind: 'github_webhook',
      ingress_key: 'replayed-delivery'
    },
    () => 'discarded-candidate'
  )

  assert.equal(admission.run_id, 'original-run')
  assert.equal(admission.created, false)
  assert.equal(admission.preparation_token, null)
})
