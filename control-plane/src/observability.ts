import type { PublicationStepRecord, ReviewRunRecord } from './review-store.js'

/** Stable, connector-neutral fields intended for operators and future query clients. */
export interface ObservedRun {
  run_id: string
  workflow: ReviewRunRecord['workflow']
  status: ReviewRunRecord['status']
  execution_status: ReviewRunRecord['runner_status']
  publication_status: ReviewRunRecord['publication_status']
  created_at: string
  updated_at: string
  published_at: string | null
  failure_code: string | null
  artifact_storage: ReviewRunRecord['artifact_storage']
  publication_steps?: readonly PublicationStepSummary[]
}

export interface PublicationStepSummary {
  step_key: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
  failure_count: number
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

export function observeRun(run: ReviewRunRecord): ObservedRun {
  return {
    run_id: run.run_id,
    workflow: run.workflow,
    status: run.status,
    execution_status: run.runner_status,
    publication_status: run.publication_status,
    created_at: run.created_at,
    updated_at: run.updated_at,
    published_at: run.published_at,
    failure_code: run.failure_code,
    artifact_storage: run.artifact_storage
  }
}

export function observePublicationStep(step: PublicationStepRecord): PublicationStepSummary {
  return {
    step_key: step.step_key,
    status: step.status,
    failure_count: step.failure_count,
    remote_object_url: step.remote_object_url,
    failure_code: step.failure_code,
    failure_message: step.failure_message
  }
}
