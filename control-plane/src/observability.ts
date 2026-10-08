import type { ReviewRunRecord } from './review-store.js'

/** Stable, connector-neutral fields intended for operators and future query clients. */
export interface ObservedRun {
  run_id: string
  workflow: ReviewRunRecord['workflow']
  status: ReviewRunRecord['status']
  created_at: string
  updated_at: string
  published_at: string | null
  failure_code: string | null
  artifact_publication: ReviewRunRecord['artifact_publication']
  publication_steps?: readonly PublicationStepSummary[]
}

export interface PublicationStepSummary {
  step_key: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'terminal_failed'
  failure_count: number
  failure_code: string | null
}

export function observeRun(run: ReviewRunRecord): ObservedRun {
  return {
    run_id: run.run_id,
    workflow: run.workflow,
    status: run.status,
    created_at: run.created_at,
    updated_at: run.updated_at,
    published_at: run.published_at,
    failure_code: run.failure_code,
    artifact_publication: run.artifact_publication
  }
}
