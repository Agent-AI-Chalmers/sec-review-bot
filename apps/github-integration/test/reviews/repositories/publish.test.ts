import assert from 'node:assert/strict'
import test from 'node:test'

import { publishDeliveryDraftPrs } from '../../../src/reviews/repositories/publish.js'
import type {
  ControlPlaneClient,
  PublicationStepRecord
} from '../../../src/control-plane/client.js'
import type { RepositoryDelivery } from '../../../src/reviews/repositories/result.js'

function delivery(delivery_id: string): RepositoryDelivery {
  return {
    delivery_id,
    case_count: 0,
    case_ids: [],
    file_changes: [
      {
        path: `src/${delivery_id}.ts`,
        status: 'upsert',
        content: 'export const fixed = true\n',
        content_encoding: 'utf-8'
      }
    ]
  }
}

function step(
  step_key: string,
  overrides: Partial<PublicationStepRecord> = {}
): PublicationStepRecord {
  return {
    step_key,
    status: 'pending',
    attempts: 0,
    remote_object_id: null,
    remote_object_url: null,
    failure_code: null,
    failure_message: null,
    ...overrides
  }
}

test('repository delivery recovery skips succeeded steps and resumes the failed delivery', async () => {
  const steps = [
    step('repository:delivery:delivery-a', {
      status: 'succeeded',
      remote_object_id: '11',
      remote_object_url: 'https://example.test/pull/11'
    }),
    step('repository:delivery:delivery-b', { status: 'failed', attempts: 1 })
  ]
  const claimed: string[] = []
  const completed: string[] = []
  const store = {
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (_runId: string, _token: string, stepKey: string) => {
      claimed.push(stepKey)
    },
    completePublicationStep: async (_runId: string, _token: string, stepKey: string) => {
      completed.push(stepKey)
      return true
    },
    failPublicationStep: async () => true
  } as unknown as ControlPlaneClient

  const published = await publishDeliveryDraftPrs({
    octokit: {} as never,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    } as never,
    run_id: 'run-1',
    workspace_ref: 'main',
    deliveries: [delivery('delivery-a'), delivery('delivery-b')],
    case_results: [],
    event_type: 'manual',
    store,
    claim_token: 'claim-1',
    assert_publication_claim: async () => {},
    create_delivery_draft_pr: async ({ delivery }) => ({
      title: `Fix ${delivery.delivery_id}`,
      number: 12,
      html_url: 'https://example.test/pull/12',
      branch_name: 'sec-review-bot/repo-scan/run-1/delivery-b',
      body: 'Delivery body',
      reused: false
    })
  })

  assert.deepEqual(claimed, ['repository:delivery:delivery-b'])
  assert.deepEqual(completed, ['repository:delivery:delivery-b'])
  assert.deepEqual(
    published.map((item) => item.html_url),
    ['https://example.test/pull/11', 'https://example.test/pull/12']
  )
})

test('repository delivery continues after a deterministic failure', async () => {
  const steps = [step('repository:delivery:delivery-a'), step('repository:delivery:delivery-b')]
  const failures: Array<{ stepKey: string; retry: boolean | undefined }> = []
  const attempted: string[] = []
  const store = {
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async () => {},
    completePublicationStep: async () => true,
    failPublicationStep: async (
      _runId: string,
      _token: string,
      stepKey: string,
      _error: unknown,
      options: { retry?: boolean }
    ) => {
      failures.push({ stepKey, retry: options.retry })
      return true
    }
  } as unknown as ControlPlaneClient

  const published = await publishDeliveryDraftPrs({
    octokit: {} as never,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    } as never,
    run_id: 'run-1',
    workspace_ref: 'main',
    deliveries: [delivery('delivery-a'), delivery('delivery-b')],
    case_results: [],
    event_type: 'manual',
    store,
    claim_token: 'claim-1',
    assert_publication_claim: async () => {},
    create_delivery_draft_pr: async ({ delivery }) => {
      attempted.push(delivery.delivery_id)
      if (delivery.delivery_id === 'delivery-a') {
        throw Object.assign(new Error('Validation failed.'), {
          response: { status: 422, headers: {}, data: { message: 'Validation failed.' } }
        })
      }
      return {
        title: 'Fix B',
        number: 12,
        html_url: 'https://example.test/pull/12',
        branch_name: 'sec-review-bot/repo-scan/run-1/delivery-b',
        body: 'Delivery body',
        reused: false
      }
    }
  })

  assert.deepEqual(attempted, ['delivery-a', 'delivery-b'])
  assert.deepEqual(failures, [{ stepKey: 'repository:delivery:delivery-a', retry: false }])
  assert.deepEqual(
    published.map((item) => item.html_url),
    ['https://example.test/pull/12']
  )
})

test('repository delivery recovery skips terminal failures and reaches later work', async () => {
  const steps = [
    step('repository:delivery:delivery-a', {
      status: 'terminal_failed',
      attempts: 1,
      failure_code: 'GITHUB_VALIDATION_REJECTED'
    }),
    step('repository:delivery:delivery-b')
  ]
  const claimed: string[] = []
  const store = {
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (_runId: string, _token: string, stepKey: string) => {
      claimed.push(stepKey)
    },
    completePublicationStep: async () => true,
    failPublicationStep: async () => true
  } as unknown as ControlPlaneClient

  const published = await publishDeliveryDraftPrs({
    octokit: {} as never,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    } as never,
    run_id: 'run-1',
    workspace_ref: 'main',
    deliveries: [delivery('delivery-a'), delivery('delivery-b')],
    case_results: [],
    event_type: 'manual',
    store,
    claim_token: 'claim-2',
    assert_publication_claim: async () => {},
    create_delivery_draft_pr: async () => ({
      title: 'Fix B',
      number: 12,
      html_url: 'https://example.test/pull/12',
      branch_name: 'sec-review-bot/repo-scan/run-1/delivery-b',
      body: 'Delivery body',
      reused: false
    })
  })

  assert.deepEqual(claimed, ['repository:delivery:delivery-b'])
  assert.deepEqual(
    published.map((item) => item.html_url),
    ['https://example.test/pull/12']
  )
})
