import type { RunnerArtifactPublication, WorkflowName } from './client.js'
import { parsePublishContextForWorkflow, type PublishContext } from './publish-context.js'

type JsonObject = Record<string, unknown>
export type ReviewRunStatus = 'preparing' | 'recovering' | 'queued' | 'running' | 'publishing' | 'published' | 'failed'
export interface CreateReviewRunArgs { run_id: string, workflow: WorkflowName, publish_context: JsonObject, runner_input?: JsonObject, ingress_kind?: 'github_webhook' | 'github_actions_dispatch', ingress_key?: string }
export interface ReviewRunRecord extends CreateReviewRunArgs { status: ReviewRunStatus, created_at: string, updated_at: string, published_at: string | null, failure_code: string | null, failure_message: string | null, artifact_publication: RunnerArtifactPublication | null }
export interface ReviewRunAdmission { record: ReviewRunRecord, created: boolean, preparation_token: string | null }
export interface PublicationStepRecord { step_key: string, status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed', attempts: number, remote_object_id: string | null, remote_object_url: string | null, failure_code: string | null, failure_message: string | null }

function serviceUrl (): string {
  const value = process.env.CONTROL_PLANE_SERVICE_URL?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_URL is required.')
  return value.replace(/\/+$/, '')
}
function serviceToken (): string {
  const value = process.env.CONTROL_PLANE_SERVICE_TOKEN?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_TOKEN is required.')
  return value
}

class ControlPlaneReviewRunStoreClient {
  readonly connector_id = process.env.CONNECTOR_ID?.trim() || 'github-app:default'
  private async call<T> (operation: string, ...args: unknown[]): Promise<T> {
    const response = await fetch(`${serviceUrl()}/v1/store`, { method: 'POST', headers: { authorization: `Bearer ${serviceToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, args }) })
    const body = await response.json() as { result?: T, error?: string }
    if (!response.ok) throw new Error(body.error ?? `Control Plane returned HTTP ${response.status}.`)
    return body.result as T
  }
  private validateRun (run: ReviewRunRecord): ReviewRunRecord { return { ...run, publish_context: parsePublishContextForWorkflow(run.workflow, run.publish_context) } }
  private async validateContext (runId: string, context: PublishContext): Promise<PublishContext> {
    const run = await this.getRun(runId)
    if (run === null) throw new Error(`Control Plane run does not exist: ${runId}`)
    return parsePublishContextForWorkflow(run.workflow, context)
  }
  async initialize (): Promise<void> {}
  async close (): Promise<void> {}
  async admit_review_run (run: CreateReviewRunArgs & Required<Pick<CreateReviewRunArgs, 'ingress_kind' | 'ingress_key'>>): Promise<ReviewRunAdmission> { parsePublishContextForWorkflow(run.workflow, run.publish_context); const admission = await this.call<ReviewRunAdmission>('admit_review_run', run); return { ...admission, record: this.validateRun(admission.record) } }
  async save_prepared_submission (runId: string, token: string, context: PublishContext, input: JsonObject): Promise<void> { await this.call('save_prepared_submission', runId, token, await this.validateContext(runId, context), input) }
  async mark_queued (runId: string, token: string, context: PublishContext): Promise<void> { await this.call('mark_queued', runId, token, await this.validateContext(runId, context)) }
  async getRun (runId: string): Promise<ReviewRunRecord | null> { const run = await this.call<ReviewRunRecord | null>('getRun', runId); return run === null ? null : this.validateRun(run) }
  async expireStalePreparations (): Promise<number> { return await this.call('expireStalePreparations') }
  async listSubmissionRecoveries (): Promise<ReviewRunRecord[]> { return (await this.call<ReviewRunRecord[]>('listSubmissionRecoveries')).map(run => this.validateRun(run)) }
  async claimSubmissionRecovery (runId: string): Promise<string | null> { return await this.call('claimSubmissionRecovery', runId) }
  async completeSubmissionRecovery (runId: string, token: string): Promise<boolean> { return await this.call('completeSubmissionRecovery', runId, token) }
  async failSubmissionRecovery (runId: string, token: string, error: { code?: string | null, message: string }): Promise<boolean> { return await this.call('failSubmissionRecovery', runId, token, error) }
  async listActiveRuns (): Promise<ReviewRunRecord[]> { return (await this.call<ReviewRunRecord[]>('listActiveRuns')).map(run => this.validateRun(run)) }
  async markRunning (runId: string): Promise<void> { await this.call('markRunning', runId) }
  async recordArtifactPublication (runId: string, publication: RunnerArtifactPublication | undefined): Promise<void> { await this.call('recordArtifactPublication', runId, publication) }
  async failRunnerExecution (runId: string, error: { code?: string | null, message: string }): Promise<boolean> { return await this.call('failRunnerExecution', runId, error) }
  async claimPublication (runId: string): Promise<string | null> { return await this.call('claimPublication', runId) }
  async renewPublicationClaim (runId: string, token: string): Promise<boolean> { return await this.call('renewPublicationClaim', runId, token) }
  publicationHeartbeatIntervalMs (): number { return 60_000 }
  async initializePublicationSteps (runId: string, token: string, keys: string[]): Promise<void> { await this.call('initializePublicationSteps', runId, token, keys) }
  async listPublicationSteps (runId: string): Promise<PublicationStepRecord[]> { return await this.call('listPublicationSteps', runId) }
  async requirePublicationStepClaim (runId: string, token: string, key: string): Promise<void> { await this.call('requirePublicationStepClaim', runId, token, key) }
  async completePublicationStep (runId: string, token: string, key: string, remote: { id?: string | number | null, url?: string | null } = {}): Promise<boolean> { return await this.call('completePublicationStep', runId, token, key, remote) }
  async failPublicationStep (runId: string, token: string, key: string, error: { code?: string | null, message: string }, options: { retry?: boolean } = {}): Promise<boolean> { return await this.call('failPublicationStep', runId, token, key, error, options) }
  async completePublication (runId: string, token: string): Promise<boolean> { return await this.call('completePublication', runId, token) }
  async failPublication (runId: string, token: string, error: { code?: string | null, message: string }, options: { retry: boolean }): Promise<boolean> { return await this.call('failPublication', runId, token, error, options) }
  async failPreparation (runId: string, token: string, error: { code?: string | null, message: string }): Promise<void> { await this.call('failPreparation', runId, token, error) }
}
export type ReviewRunStore = Pick<ControlPlaneReviewRunStoreClient,
  | 'connector_id' | 'admit_review_run' | 'save_prepared_submission' | 'mark_queued'
  | 'getRun' | 'expireStalePreparations' | 'listSubmissionRecoveries'
  | 'claimSubmissionRecovery' | 'completeSubmissionRecovery' | 'failSubmissionRecovery'
  | 'listActiveRuns' | 'markRunning' | 'recordArtifactPublication' | 'failRunnerExecution'
  | 'claimPublication' | 'renewPublicationClaim' | 'publicationHeartbeatIntervalMs'
  | 'initializePublicationSteps' | 'listPublicationSteps' | 'requirePublicationStepClaim'
  | 'completePublicationStep' | 'failPublicationStep' | 'completePublication'
  | 'failPublication' | 'failPreparation'>
export const reviewRunStore: ReviewRunStore = new ControlPlaneReviewRunStoreClient()
