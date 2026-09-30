import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ReviewRunStore } from '../../infrastructure/runner/review-store.js'

function createStore (): ReviewRunStore {
  return new ReviewRunStore(':memory:')
}

function createQueuedRun (store: ReviewRunStore, run: Parameters<ReviewRunStore['create_preparing_review_run']>[0]) {
  store.create_preparing_review_run(run)
  store.mark_queued(run.run_id, run.publish_context)
  return store.getRun(run.run_id)!
}

function temporaryDatabasePath (): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-run-store-')), 'review-runs.sqlite')
}

test('ReviewRunStore can be closed more than once during shutdown', () => {
  const store = createStore()

  store.close()
  assert.doesNotThrow(() => store.close())
})

test('ReviewRunStore persists and restores queued runner runs', () => {
  const store = createStore()

  const record = createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-1',
    publish_context: {
      repo: {
        repo_full_name: 'owner/repo'
      },
      workspace_ref: 'base-sha',
      event_type: 'manual'
    }
  })

  assert.equal(record.status, 'queued')
  assert.equal(record.publish_attempts, 0)
  assert.equal(record.workflow, 'repository-review')
  assert.equal(record.run_id, 'run-1')
  assert.deepEqual(record.publish_context, {
    repo: {
      repo_full_name: 'owner/repo'
    },
    workspace_ref: 'base-sha',
    event_type: 'manual'
  })

  assert.equal(store.listActiveRuns().length, 1)
})

test('ReviewRunStore keeps preparing runs out of the Runner poller', () => {
  const store = createStore()
  const record = store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-preparing',
    publish_context: {}
  })

  assert.equal(record.status, 'preparing')
  assert.deepEqual(store.listActiveRuns(), [])
  assert.throws(
    () => store.create_preparing_review_run({
      workflow: 'issue-review',
      run_id: 'run-preparing',
      publish_context: {}
    }),
    /UNIQUE constraint failed/
  )
})

test('ReviewRunStore marks preparations interrupted by a previous process', () => {
  const dbPath = temporaryDatabasePath()
  const first = new ReviewRunStore(dbPath)
  first.create_preparing_review_run({ workflow: 'issue-review', run_id: 'run-interrupted', publish_context: {} })
  first.close()

  const restarted = new ReviewRunStore(dbPath)
  const record = restarted.getRun('run-interrupted')
  assert.equal(record?.status, 'failed')
  assert.equal(record?.failure_code, 'PREPARATION_INTERRUPTED')
  restarted.close()
})

test('ReviewRunStore reclaims an interrupted ingress with the original run id', () => {
  const store = new ReviewRunStore(temporaryDatabasePath())
  store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-reclaim',
    publish_context: {},
    ingress_kind: 'github_webhook',
    ingress_key: 'delivery-reclaim'
  })

  // Simulate a restart without reopening the database in this focused test.
  store.markFailed('run-reclaim', { code: 'PREPARATION_INTERRUPTED', message: 'interrupted' })
  const admission = store.admit_review_run({
    workflow: 'issue-review',
    run_id: 'run-new',
    publish_context: {},
    ingress_kind: 'github_webhook',
    ingress_key: 'delivery-reclaim'
  })

  assert.equal(admission.created, true)
  assert.equal(admission.record.run_id, 'run-reclaim')
  assert.equal(admission.record.status, 'preparing')
  store.close()
})

test('ReviewRunStore keeps uncertain submissions out of ordinary preparation recovery', () => {
  const store = createStore()
  store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-uncertain',
    publish_context: {},
    ingress_kind: 'github_webhook',
    ingress_key: 'delivery-uncertain'
  })
  store.save_prepared_submission('run-uncertain', { workspace_ref: 'abc' }, { contract_version: 'v4' })
  store.markFailed('run-uncertain', { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' })

  const admission = store.admit_review_run({
    workflow: 'issue-review',
    run_id: 'run-new',
    publish_context: {},
    ingress_kind: 'github_webhook',
    ingress_key: 'delivery-uncertain'
  })

  assert.equal(admission.created, false)
  assert.equal(admission.record.status, 'failed')
  assert.deepEqual(admission.record.publish_context, { workspace_ref: 'abc' })
  assert.deepEqual(admission.record.runner_input, { contract_version: 'v4' })

  const claimToken = store.claimSubmissionRecovery('run-uncertain')
  assert.equal(typeof claimToken, 'string')
  assert.equal(store.claimSubmissionRecovery('run-uncertain'), null)
  assert.equal(store.getRun('run-uncertain')?.status, 'recovering')
  assert.equal(store.completeSubmissionRecovery('run-uncertain', claimToken!), true)
  assert.equal(store.getRun('run-uncertain')?.status, 'queued')
  store.close()
})

test('ReviewRunStore fences a worker after its recovery claim is replaced', async () => {
  const store = new ReviewRunStore(':memory:', { publishingClaimTimeoutMs: 0 })
  store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-fenced',
    publish_context: {}
  })
  store.save_prepared_submission('run-fenced', {}, { contract_version: 'v4' })
  store.markFailed('run-fenced', { code: 'SUBMISSION_STATE_UNCERTAIN', message: 'response lost' })

  const oldClaim = store.claimSubmissionRecovery('run-fenced')
  assert.equal(typeof oldClaim, 'string')
  await new Promise(resolve => setTimeout(resolve, 5))
  const currentClaim = store.claimSubmissionRecovery('run-fenced')
  assert.equal(typeof currentClaim, 'string')
  assert.notEqual(currentClaim, oldClaim)

  assert.equal(store.completeSubmissionRecovery('run-fenced', oldClaim!), false)
  assert.equal(store.failSubmissionRecovery('run-fenced', oldClaim!, {
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'stale worker failed'
  }), false)
  assert.equal(store.getRun('run-fenced')?.status, 'recovering')
  assert.equal(store.completeSubmissionRecovery('run-fenced', currentClaim!), true)
  assert.equal(store.getRun('run-fenced')?.status, 'queued')
  store.close()
})

test('ReviewRunStore only queues a run from preparing', () => {
  const store = createStore()
  store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-transition',
    publish_context: {}
  })

  store.mark_queued('run-transition', { issue: { issue_number: 7 } })
  assert.equal(store.getRun('run-transition')?.status, 'queued')
  assert.throws(
    () => store.mark_queued('run-transition', {}),
    /cannot transition from preparing to queued/
  )
})

test('ReviewRunStore atomically reuses the run admitted for the same ingress request', () => {
  const store = createStore()
  const first = store.admit_review_run({
    workflow: 'repository-review',
    run_id: 'run-first',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:12345'
  })
  const replay = store.admit_review_run({
    workflow: 'repository-review',
    run_id: 'run-second',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:12345'
  })

  assert.equal(first.created, true)
  assert.equal(replay.created, false)
  assert.equal(replay.record.run_id, 'run-first')
  assert.equal(store.getRun('run-second'), null)
})

test('ReviewRunStore does not treat a run id constraint as an ingress replay', () => {
  const store = createStore()
  store.admit_review_run({
    workflow: 'repository-review',
    run_id: 'run-shared',
    publish_context: {},
    ingress_kind: 'github_actions_dispatch',
    ingress_key: 'octo/example:first'
  })

  assert.throws(
    () => store.admit_review_run({
      workflow: 'repository-review',
      run_id: 'run-shared',
      publish_context: {},
      ingress_kind: 'github_actions_dispatch',
      ingress_key: 'octo/example:second'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SQLITE_CONSTRAINT_PRIMARYKEY')
      return true
    }
  )
})

test('ReviewRunStore removes published runs from active list', () => {
  const store = createStore()
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-2',
    publish_context: {}
  })

  store.markRunning('run-2')
  assert.equal(store.listActiveRuns()[0]?.status, 'running')

  store.markPublished('run-2')
  assert.equal(store.listActiveRuns().length, 0)
  assert.equal(store.getRun('run-2')?.status, 'published')
})

test('ReviewRunStore keeps publish failures active for retry', () => {
  const store = createStore()
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-3',
    publish_context: {}
  })

  store.markPublishing('run-3')
  store.markPublishFailed('run-3', {
    code: 'GITHUB_API_TEMPORARY',
    message: 'GitHub API unavailable.'
  })

  const failedRecord = store.getRun('run-3')
  assert.equal(failedRecord?.status, 'publish_failed')
  assert.equal(failedRecord?.publish_attempts, 1)
  assert.equal(failedRecord?.failure_code, 'GITHUB_API_TEMPORARY')
  assert.equal(store.listActiveRuns()[0]?.run_id, 'run-3')

  store.markPublishing('run-3')
  const retryingRecord = store.getRun('run-3')
  assert.equal(retryingRecord?.status, 'publishing')
  assert.equal(retryingRecord?.publish_attempts, 1)
  assert.equal(retryingRecord?.failure_code, null)
  assert.equal(retryingRecord?.failure_message, null)
})

test('ReviewRunStore only claims publishable runs for publishing once', () => {
  const store = createStore()
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-claim',
    publish_context: {}
  })

  assert.equal(store.markPublishing('run-claim'), true)
  assert.equal(store.markPublishing('run-claim'), false)
  assert.equal(store.getRun('run-claim')?.publish_attempts, 0)
})

test('ReviewRunStore reclaims stale publishing runs', async () => {
  const store = new ReviewRunStore(':memory:', {
    publishingClaimTimeoutMs: 0
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-stale-publishing',
    publish_context: {}
  })

  assert.equal(store.markPublishing('run-stale-publishing'), true)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(store.markPublishing('run-stale-publishing'), true)
  assert.equal(store.getRun('run-stale-publishing')?.publish_attempts, 0)
})

test('ReviewRunStore reclaims stale final publish attempt without exhausting retries', async () => {
  const store = new ReviewRunStore(':memory:', {
    publishingClaimTimeoutMs: 0
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-final-attempt',
    publish_context: {}
  })

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    assert.equal(store.markPublishing('run-final-attempt'), true)
    store.markPublishFailed('run-final-attempt', {
      code: 'GITHUB_API_TEMPORARY',
      message: 'GitHub API unavailable.'
    })
  }

  assert.equal(store.markPublishing('run-final-attempt'), true)
  assert.equal(store.getRun('run-final-attempt')?.publish_attempts, 2)
  await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(store.markPublishing('run-final-attempt'), true)
  const reclaimedRecord = store.getRun('run-final-attempt')
  assert.equal(reclaimedRecord?.status, 'publishing')
  assert.equal(reclaimedRecord?.publish_attempts, 2)
  assert.equal(reclaimedRecord?.failure_code, null)
  assert.equal(reclaimedRecord?.failure_message, null)
})

test('ReviewRunStore stops listing publish failures after max publish attempts', () => {
  const store = createStore()
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-4',
    publish_context: {}
  })

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    store.markPublishing('run-4')
    store.markPublishFailed('run-4', {
      code: 'GITHUB_API_PERMANENT',
      message: 'GitHub rejected the publish request.'
    })
  }

  const failedRecord = store.getRun('run-4')
  assert.equal(failedRecord?.status, 'publish_failed')
  assert.equal(failedRecord?.publish_attempts, 3)
  assert.equal(store.listActiveRuns().length, 0)
})

test('ReviewRunStore exposes publish lifecycle diagnostics', () => {
  const store = createStore()
  const publish_context = {}

  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-queued',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-published',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-failed',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-publish-failed',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-retry-exhausted',
    publish_context
  })

  store.markPublished('run-published')
  store.markFailed('run-failed', {
    code: 'RUNNER_FAILED',
    message: 'Runner failed.'
  })
  store.markPublishing('run-publish-failed')
  store.markPublishFailed('run-publish-failed', {
    code: 'GITHUB_API_TEMPORARY',
    message: 'GitHub API unavailable.'
  })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    store.markPublishing('run-retry-exhausted')
    store.markPublishFailed('run-retry-exhausted', {
      code: 'GITHUB_API_PERMANENT',
      message: 'GitHub rejected the publish request.'
    })
  }

  const diagnostics = new Map(
    store.listRunsForDiagnostics().map((run) => [run.run_id, run])
  )

  assert.equal(diagnostics.get('run-queued')?.is_active, true)
  assert.equal(diagnostics.get('run-queued')?.is_terminal, false)
  assert.equal(diagnostics.get('run-queued')?.publish_attempts_remaining, 3)

  assert.equal(diagnostics.get('run-published')?.is_active, false)
  assert.equal(diagnostics.get('run-published')?.is_terminal, true)
  assert.equal(diagnostics.get('run-published')?.retry_exhausted, false)

  assert.equal(diagnostics.get('run-failed')?.is_active, false)
  assert.equal(diagnostics.get('run-failed')?.is_terminal, true)
  assert.equal(diagnostics.get('run-failed')?.retry_exhausted, false)

  assert.equal(diagnostics.get('run-publish-failed')?.is_active, true)
  assert.equal(diagnostics.get('run-publish-failed')?.is_terminal, false)
  assert.equal(diagnostics.get('run-publish-failed')?.publish_attempts_remaining, 2)

  assert.equal(diagnostics.get('run-retry-exhausted')?.is_active, false)
  assert.equal(diagnostics.get('run-retry-exhausted')?.is_terminal, true)
  assert.equal(diagnostics.get('run-retry-exhausted')?.retry_exhausted, true)
  assert.equal(diagnostics.get('run-retry-exhausted')?.publish_attempts_remaining, 0)
})

test('ReviewRunStore filters diagnostics by status and lifecycle state', () => {
  const store = createStore()
  const publish_context = {}

  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-queued',
    publish_context
  })
  store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-uncertain',
    publish_context
  })
  store.save_prepared_submission('run-uncertain', publish_context, { contract_version: 'v4' })
  store.markFailed('run-uncertain', {
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'response lost'
  })
  store.create_preparing_review_run({
    workflow: 'issue-review',
    run_id: 'run-recovering',
    publish_context
  })
  store.save_prepared_submission('run-recovering', publish_context, { contract_version: 'v4' })
  store.markFailed('run-recovering', {
    code: 'SUBMISSION_STATE_UNCERTAIN',
    message: 'response lost'
  })
  assert.equal(typeof store.claimSubmissionRecovery('run-recovering'), 'string')
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-published',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-failed',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-publish-failed',
    publish_context
  })
  createQueuedRun(store, {
    workflow: 'repository-review',
    run_id: 'run-retry-exhausted',
    publish_context
  })

  store.markPublished('run-published')
  store.markFailed('run-failed', {
    code: 'RUNNER_FAILED',
    message: 'Runner failed.'
  })
  store.markPublishing('run-publish-failed')
  store.markPublishFailed('run-publish-failed', {
    code: 'GITHUB_API_TEMPORARY',
    message: 'GitHub API unavailable.'
  })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    store.markPublishing('run-retry-exhausted')
    store.markPublishFailed('run-retry-exhausted', {
      code: 'GITHUB_API_TEMPORARY',
      message: 'GitHub API unavailable.'
    })
  }

  assert.deepEqual(
    store.listRunsForDiagnostics({ status: 'published' }).map(run => run.run_id),
    ['run-published']
  )
  assert.deepEqual(
    new Set(store.listRunsForDiagnostics({ active_only: true }).map(run => run.run_id)),
    new Set(['run-uncertain', 'run-recovering', 'run-queued', 'run-publish-failed'])
  )
  assert.deepEqual(
    new Set(store.listRunsForDiagnostics({ failed_only: true }).map(run => run.run_id)),
    new Set(['run-failed', 'run-uncertain', 'run-publish-failed', 'run-retry-exhausted'])
  )
  assert.deepEqual(
    store.listRunsForDiagnostics({ status: 'failed', active_only: true }).map(run => run.run_id),
    ['run-uncertain']
  )
})
