import { expect, test } from 'vitest'

import { ensureSummaryIssueNumber } from '../../../src/reviews/repositories/publish.js'
import { REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE } from '../../../src/reviews/repositories/renderer.js'

import { publishDeliveryDraftPrs } from '../../../src/reviews/repositories/publish.js'
import type {
  PublicationStepRecord,
  PublicationStepStore
} from '../../../src/review-runs/client.js'
import type { RepositoryDelivery } from '../../../src/reviews/repositories/result.js'
import { fakeGitHub, githubJson, unusedGitHub } from '../../github-client.js'

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
    attempt_count: 1,
    last_attempt_at: '2026-01-01T00:00:00.000Z',
    unresolved_recovery_count: 0,
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
    step('repository:delivery:delivery-b', {
      status: 'failed'
    })
  ]
  const claimed: string[] = []
  const completed: string[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (_runId: string, _token: string, stepKey: string) => {
      claimed.push(stepKey)
    },
    completePublicationStep: async (_runId: string, _token: string, stepKey: string) => {
      completed.push(stepKey)
      return true
    },
    settleExhaustedPublicationStep: async () => true,
    failPublicationStep: async () => true
  } satisfies PublicationStepStore

  const published = await publishDeliveryDraftPrs({
    octokit: unusedGitHub().octokit,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    },
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

  expect(claimed).toStrictEqual(['repository:delivery:delivery-b'])
  expect(completed).toStrictEqual(['repository:delivery:delivery-b'])
  expect(published.map((item) => item.html_url)).toStrictEqual([
    'https://example.test/pull/11',
    'https://example.test/pull/12'
  ])
})

test('repository delivery continues after a deterministic failure', async () => {
  const steps = [step('repository:delivery:delivery-a'), step('repository:delivery:delivery-b')]
  const failures: Array<{ stepKey: string; retry: boolean | undefined }> = []
  const attempted: string[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async () => {},
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async () => true,
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
  } satisfies PublicationStepStore

  const published = await publishDeliveryDraftPrs({
    octokit: unusedGitHub().octokit,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    },
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
          response: {
            status: 422,
            headers: {},
            data: { message: 'Validation failed.' }
          }
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

  expect(attempted).toStrictEqual(['delivery-a', 'delivery-b'])
  expect(failures).toStrictEqual([{ stepKey: 'repository:delivery:delivery-a', retry: false }])
  expect(published.map((item) => item.html_url)).toStrictEqual(['https://example.test/pull/12'])
})

test('repository delivery stops the publication when the credential is refused', async () => {
  const steps = [step('repository:delivery:delivery-a'), step('repository:delivery:delivery-b')]
  const attempted: string[] = []
  const failures: Array<{ stepKey: string; retry: boolean | undefined }> = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async () => {},
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async () => true,
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
  } satisfies PublicationStepStore

  // A 401 belongs to the credential, not to this delivery: every remaining delivery would fail
  // the same way, so the publication must stop rather than record the same failure again.
  await expect(
    publishDeliveryDraftPrs({
      octokit: unusedGitHub().octokit,
      repo: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main'
      },
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
        throw Object.assign(new Error('Bad credentials'), {
          response: {
            status: 401,
            headers: {},
            data: { message: 'Bad credentials' }
          }
        })
      }
    })
  ).rejects.toSatisfy(() => true)

  expect(attempted).toStrictEqual(['delivery-a'])
  expect(failures).toStrictEqual([{ stepKey: 'repository:delivery:delivery-a', retry: false }])
})

test('repository delivery recovery skips terminal failures and reaches later work', async () => {
  const steps = [
    step('repository:delivery:delivery-a', {
      status: 'terminal_failed',
      failure_code: 'GITHUB_VALIDATION_REJECTED'
    }),
    step('repository:delivery:delivery-b')
  ]
  const claimed: string[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (_runId: string, _token: string, stepKey: string) => {
      claimed.push(stepKey)
    },
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async () => true,
    failPublicationStep: async () => true
  } satisfies PublicationStepStore

  const published = await publishDeliveryDraftPrs({
    octokit: unusedGitHub().octokit,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    },
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

  expect(claimed).toStrictEqual(['repository:delivery:delivery-b'])
  expect(published.map((item) => item.html_url)).toStrictEqual(['https://example.test/pull/12'])
})
test('summary issue lookup reuses an issue when the create response is lost', async () => {
  let created = false
  let createAttempts = 0
  const { octokit } = fakeGitHub(({ method, url }) => {
    const pathname = new URL(url).pathname
    if (method === 'GET' && /\/issues$/.test(pathname)) {
      return githubJson(
        created
          ? [
              {
                number: 17,
                title: REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE,
                pull_request: undefined
              }
            ]
          : []
      )
    }
    if (method === 'POST' && /\/issues$/.test(pathname)) {
      createAttempts += 1
      created = true
      // The response is lost after GitHub created the issue: a transport-level failure.
      throw new Error('response lost after issue creation')
    }
    return githubJson({})
  })
  const repo = {
    owner_login: 'octo',
    repo_name: 'example',
    default_branch: 'main'
  }
  const ensure = () =>
    ensureSummaryIssueNumber(
      octokit,
      { ...repo, repo_full_name: `${repo.owner_login}/${repo.repo_name}` },
      async () => {}
    )
  await expect(ensure()).rejects.toThrow(/response lost/)
  expect(await ensure()).toBe(17)
  expect(createAttempts).toBe(1)
})

test('an exhausted delivery step is concluded from the draft PR a previous owner opened', async () => {
  // The failure this prevents: a publisher opened the delivery's draft PR and died before
  // recording it. The step then runs out of attempts, and concluding it as a failure would
  // report a PR that is on GitHub as missing. The head branch embeds the run and delivery ids,
  // so an open PR from it is this step's side effect.
  const steps = [step('repository:delivery:delivery-a')]
  const settles: Array<{ stepKey: string; found: unknown }> = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async () => {
      throw Object.assign(new Error('no attempts left'), {
        code: 'PUBLICATION_STEP_RETRY_EXHAUSTED'
      })
    },
    completePublicationStep: async () => true,
    settleExhaustedPublicationStep: async (
      _runId: string,
      _token: string,
      stepKey: string,
      found: unknown
    ) => {
      settles.push({ stepKey, found })
      return true
    },
    failPublicationStep: async () => true
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url }) => {
    if (new URL(url).pathname.endsWith('/pulls') && method === 'GET') {
      return githubJson([{ number: 77, html_url: 'https://example.test/pull/77' }])
    }
    return githubJson({})
  })

  const published = await publishDeliveryDraftPrs({
    octokit,
    repo: {
      owner_login: 'octo',
      repo_name: 'example',
      repo_full_name: 'octo/example',
      default_branch: 'main'
    },
    run_id: 'run-1',
    workspace_ref: 'main',
    deliveries: [delivery('delivery-a')],
    case_results: [],
    event_type: 'manual',
    store,
    claim_token: 'claim-1',
    assert_publication_claim: async () => {},
    create_delivery_draft_pr: async () => {
      throw new Error('a settled step must not create another pull request')
    }
  })

  expect(settles).toStrictEqual([
    {
      stepKey: 'repository:delivery:delivery-a',
      found: { remote: { id: 77, url: 'https://example.test/pull/77' } }
    }
  ])
  expect(published.map((item) => item.html_url)).toStrictEqual(['https://example.test/pull/77'])
})

test('a delivery reconciliation that cannot reach GitHub is recorded once and settles nothing', async () => {
  // Settling a failed lookup would claim the PR is absent, so nothing is settled. The failure is
  // recorded on the step exactly once, retryable, which spends its reconciliation budget, and the
  // GitHub error propagates so the publication retries.
  const steps = [step('repository:delivery:delivery-a')]
  const writes: string[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async () => {
      throw Object.assign(new Error('no attempts left'), {
        code: 'PUBLICATION_STEP_RETRY_EXHAUSTED'
      })
    },
    completePublicationStep: async () => {
      writes.push('complete')
      return true
    },
    settleExhaustedPublicationStep: async () => {
      writes.push('settle')
      return true
    },
    failPublicationStep: async (
      _runId: string,
      _token: string,
      _stepKey: string,
      _error: unknown,
      options: { retry?: boolean } = {}
    ) => {
      writes.push(`fail retry=${String(options.retry)}`)
      return true
    }
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url }) => {
    if (new URL(url).pathname.endsWith('/pulls') && method === 'GET')
      return githubJson({ message: 'Bad Gateway' }, 502)
    return githubJson({})
  })

  const errors: string[] = []
  const restore = console.error
  console.error = (line: unknown) => {
    errors.push(String(line))
  }
  try {
    await expect(
      publishDeliveryDraftPrs({
        octokit,
        repo: {
          owner_login: 'octo',
          repo_name: 'example',
          repo_full_name: 'octo/example',
          default_branch: 'main'
        },
        run_id: 'run-1',
        workspace_ref: 'main',
        deliveries: [delivery('delivery-a')],
        case_results: [],
        event_type: 'manual',
        store,
        claim_token: 'claim-1',
        assert_publication_claim: async () => {},
        create_delivery_draft_pr: async () => {
          throw new Error('an unreconciled step must not create a pull request')
        }
      })
    ).rejects.toThrow(/Bad Gateway/)
  } finally {
    console.error = restore
  }
  expect(writes).toStrictEqual(['fail retry=true'])
  expect.assert(
    errors.some((line) => line.includes('delivery_draft_pr_failed') && line.includes('delivery-a')),
    'the reconciliation failure is logged with its delivery id'
  )
})

test('a deterministic reconciliation failure skips only its delivery', async () => {
  // A 404 on the lookup (the repository or branch is gone) will not change on retry, so it must
  // not stop the publication: the other deliveries still publish. The failed lookup is recorded on
  // its step as a non-retryable failure, once, and the step is not settled as absent.
  const steps = [step('repository:delivery:delivery-a'), step('repository:delivery:delivery-b')]
  const writes: string[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (_runId: string, _token: string, stepKey: string) => {
      if (stepKey === 'repository:delivery:delivery-a')
        throw Object.assign(new Error('no attempts left'), {
          code: 'PUBLICATION_STEP_RETRY_EXHAUSTED'
        })
    },
    completePublicationStep: async (_runId: string, _token: string, stepKey: string) => {
      writes.push(`complete ${stepKey}`)
      return true
    },
    settleExhaustedPublicationStep: async () => {
      writes.push('settle')
      return true
    },
    failPublicationStep: async (
      _runId: string,
      _token: string,
      stepKey: string,
      _error: unknown,
      options: { retry?: boolean } = {}
    ) => {
      writes.push(`fail ${stepKey} retry=${String(options.retry)}`)
      return true
    }
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url }) => {
    if (new URL(url).pathname.endsWith('/pulls') && method === 'GET')
      return githubJson({ message: 'Not Found' }, 404)
    return githubJson({})
  })

  const restore = console.error
  console.error = () => {}
  try {
    const published = await publishDeliveryDraftPrs({
      octokit,
      repo: {
        owner_login: 'octo',
        repo_name: 'example',
        repo_full_name: 'octo/example',
        default_branch: 'main'
      },
      run_id: 'run-1',
      workspace_ref: 'main',
      deliveries: [delivery('delivery-a'), delivery('delivery-b')],
      case_results: [],
      event_type: 'manual',
      store,
      claim_token: 'claim-1',
      assert_publication_claim: async () => {},
      create_delivery_draft_pr: async () => ({
        title: 'b',
        number: 2,
        html_url: 'https://example.test/pull/2',
        branch_name: 'sec-review-bot/repo-scan/run-1/delivery-b',
        body: 'Delivery body',
        reused: false
      })
    })
    expect(published.map((item) => item.html_url)).toStrictEqual(['https://example.test/pull/2'])
  } finally {
    console.error = restore
  }
  expect(writes).toStrictEqual([
    'fail repository:delivery:delivery-a retry=false',
    'complete repository:delivery:delivery-b'
  ])
})

test('a transient reconciliation failure still lets later deliveries publish before the retry', async () => {
  // The failed lookup belongs to its own step and is already recorded there. Stopping the loop on
  // it would skip the deliveries after it on every pass until that step parks, so they are
  // attempted first and the publication is still returned for retry afterwards.
  const steps = [step('repository:delivery:delivery-a'), step('repository:delivery:delivery-b')]
  const writes: string[] = []
  const store = {
    initializePublicationSteps: async () => {},
    listPublicationSteps: async () => steps,
    requirePublicationStepClaim: async (_runId: string, _token: string, stepKey: string) => {
      if (stepKey === 'repository:delivery:delivery-a')
        throw Object.assign(new Error('no attempts left'), {
          code: 'PUBLICATION_STEP_RETRY_EXHAUSTED'
        })
    },
    completePublicationStep: async (_runId: string, _token: string, stepKey: string) => {
      writes.push(`complete ${stepKey}`)
      return true
    },
    settleExhaustedPublicationStep: async () => {
      writes.push('settle')
      return true
    },
    failPublicationStep: async (
      _runId: string,
      _token: string,
      stepKey: string,
      _error: unknown,
      options: { retry?: boolean } = {}
    ) => {
      writes.push(`fail ${stepKey} retry=${String(options.retry)}`)
      return true
    }
  } satisfies PublicationStepStore

  const { octokit } = fakeGitHub(({ method, url }) => {
    if (new URL(url).pathname.endsWith('/pulls') && method === 'GET')
      return githubJson({ message: 'Bad Gateway' }, 502)
    return githubJson({})
  })

  const restore = console.error
  console.error = () => {}
  try {
    await expect(
      publishDeliveryDraftPrs({
        octokit,
        repo: {
          owner_login: 'octo',
          repo_name: 'example',
          repo_full_name: 'octo/example',
          default_branch: 'main'
        },
        run_id: 'run-1',
        workspace_ref: 'main',
        deliveries: [delivery('delivery-a'), delivery('delivery-b')],
        case_results: [],
        event_type: 'manual',
        store,
        claim_token: 'claim-1',
        assert_publication_claim: async () => {},
        create_delivery_draft_pr: async () => ({
          title: 'b',
          number: 2,
          html_url: 'https://example.test/pull/2',
          branch_name: 'sec-review-bot/repo-scan/run-1/delivery-b',
          body: 'Delivery body',
          reused: false
        })
      })
    ).rejects.toThrow(/delivery-a.*Bad Gateway/)
  } finally {
    console.error = restore
  }
  expect(writes).toStrictEqual([
    'fail repository:delivery:delivery-a retry=true',
    'complete repository:delivery:delivery-b'
  ])
})
