import type { RunnerArtifactPublication, WorkflowName } from './client.js'
import { parsePublishContextForWorkflow, type PublishContext } from './publish-context.js'

type JsonObject = Record<string, unknown>
export type ReviewRunStatus =
  | 'preparing'
  | 'recovering'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'publishing'
  | 'published'
  | 'failed'

export interface CreateReviewRunArgs {
  run_id: string
  workflow: WorkflowName
  publish_context: JsonObject
  runner_input?: JsonObject
  ingress_kind?: 'github_webhook' | 'github_actions_dispatch'
  ingress_key?: string
}

export interface ReviewRunRecord extends CreateReviewRunArgs {
  status: ReviewRunStatus
  created_at: string
  updated_at: string
  published_at: string | null
  failure_code: string | null
  failure_message: string | null
  artifact_publication: RunnerArtifactPublication | null
}

export interface ReviewRunAdmission {
  record: ReviewRunRecord
  created: boolean
  preparation_token: string | null
}

export interface PublicationWork extends ReviewRunRecord {
  workflow_result: unknown
  claim_token: string
}

export class ControlPlaneSubmissionError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'ControlPlaneSubmissionError'
    this.code = code
  }
}

export interface PublicationStepRecord {
  step_key: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
  attempts: number
  remote_object_id: string | null
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

function serviceUrl(): string {
  const value = process.env.CONTROL_PLANE_SERVICE_URL?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_URL is required.')
  return value.replace(/\/+$/, '')
}

function serviceToken(): string {
  const value = process.env.CONTROL_PLANE_SERVICE_TOKEN?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_TOKEN is required.')
  return value
}

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

class ControlPlaneReviewRunStoreClient {
  readonly connector_id = process.env.CONNECTOR_ID?.trim() || 'github-app:default'

  private async call<T>(operation: string, ...args: unknown[]): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs())
    timeout.unref?.()
    try {
      const response = await fetch(`${serviceUrl()}/v1/store`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${serviceToken()}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ operation, args }),
        signal: controller.signal
      })
      const body = (await response.json()) as { result?: T; error?: string; code?: string }
      if (!response.ok) {
        throw Object.assign(
          new Error(body.error ?? `Control Plane returned HTTP ${response.status}.`),
          { code: body.code ?? null }
        )
      }
      return body.result as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw Object.assign(new Error(`Control Plane ${operation} request timed out.`), {
          code: 'CONTROL_PLANE_REQUEST_TIMEOUT',
          cause: error
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async validateContext(runId: string, context: PublishContext): Promise<PublishContext> {
    const run = await this.getRun(runId)
    if (run === null) throw new Error(`Control Plane run does not exist: ${runId}`)
    return parsePublishContextForWorkflow(run.workflow, context)
  }

  async initialize(): Promise<void> {}

  async close(): Promise<void> {}

  // Admission deliberately persists an empty context: run identity exists
  // before input preparation discovers the workflow-specific publish target.
  async admit_review_run(
    run: CreateReviewRunArgs & Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>
  ): Promise<ReviewRunAdmission> {
    return await this.call<ReviewRunAdmission>('admit_review_run', run)
  }

  async save_prepared_submission(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    await this.call(
      'save_prepared_submission',
      runId,
      token,
      await this.validateContext(runId, context),
      input
    )
  }

  async mark_queued(runId: string, token: string, context: PublishContext): Promise<void> {
    await this.call('mark_queued', runId, token, await this.validateContext(runId, context))
  }

  async submit_prepared_run(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    const publishContext = await this.validateContext(runId, context)
    try {
      await this.call('submit_prepared_run', runId, token, publishContext, input)
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : null
      throw new ControlPlaneSubmissionError(
        error instanceof Error ? error.message : String(error),
        code
      )
    }
  }

  // Status queries must expose preparing runs whose publish context is not ready.
  // Publication claims below remain the strict persisted-context boundary.
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    return await this.call<ReviewRunRecord | null>('getRun', runId)
  }

  async renewPreparationClaim(runId: string, token: string): Promise<boolean> {
    return await this.call('renewPreparationClaim', runId, token)
  }

  async preparationHeartbeatIntervalMs(): Promise<number> {
    return await this.call('preparationHeartbeatIntervalMs')
  }

  async claimNextPublication(): Promise<PublicationWork | null> {
    const work = await this.call<PublicationWork | null>('claimNextPublication')
    if (work === null) return null
    try {
      return {
        ...work,
        publish_context: parsePublishContextForWorkflow(work.workflow, work.publish_context)
      }
    } catch (error) {
      // Validation happens after the durable claim because connector-specific
      // context does not belong in Control Plane. A corrupt record must still
      // consume that claim into a terminal failure instead of timing out forever.
      await this.failPublication(
        work.run_id,
        work.claim_token,
        {
          code:
            error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'PUBLISH_CONTEXT_INVALID',
          message: error instanceof Error ? error.message : String(error)
        },
        { retry: false }
      )
      throw error
    }
  }

  async renewPublicationClaim(runId: string, token: string): Promise<boolean> {
    return await this.call('renewPublicationClaim', runId, token)
  }

  publicationHeartbeatIntervalMs(): number {
    return 60_000
  }

  async initializePublicationSteps(runId: string, token: string, keys: string[]): Promise<void> {
    await this.call('initializePublicationSteps', runId, token, keys)
  }

  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    return await this.call('listPublicationSteps', runId)
  }

  async requirePublicationStepClaim(runId: string, token: string, key: string): Promise<void> {
    await this.call('requirePublicationStepClaim', runId, token, key)
  }

  async completePublicationStep(
    runId: string,
    token: string,
    key: string,
    remote: { id?: string | number | null; url?: string | null } = {}
  ): Promise<boolean> {
    return await this.call('completePublicationStep', runId, token, key, remote)
  }

  async failPublicationStep(
    runId: string,
    token: string,
    key: string,
    error: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    return await this.call('failPublicationStep', runId, token, key, error, options)
  }

  async completePublication(runId: string, token: string): Promise<boolean> {
    return await this.call('completePublication', runId, token)
  }

  async failPublication(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    return await this.call('failPublication', runId, token, error, options)
  }

  async failPreparation(
    runId: string,
    token: string,
    error: { code?: string | null; message: string }
  ): Promise<void> {
    await this.call('failPreparation', runId, token, error)
  }
}

export type ReviewRunStore = Pick<
  ControlPlaneReviewRunStoreClient,
  | 'connector_id'
  | 'admit_review_run'
  | 'save_prepared_submission'
  | 'mark_queued'
  | 'submit_prepared_run'
  | 'getRun'
  | 'renewPreparationClaim'
  | 'preparationHeartbeatIntervalMs'
  | 'renewPublicationClaim'
  | 'publicationHeartbeatIntervalMs'
  | 'claimNextPublication'
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'failPublicationStep'
  | 'completePublication'
  | 'failPublication'
  | 'failPreparation'
>

export const reviewRunStore: ReviewRunStore = new ControlPlaneReviewRunStoreClient()
