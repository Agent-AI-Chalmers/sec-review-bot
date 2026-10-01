import type { FileChange } from '../file-change.js'
import { validateContractPublishableRepoRelativePath } from '../repo-path.js'
import type { ReviewRecord } from '../review-record.js'
import { assertV4WorkflowResult } from '../../infrastructure/runner/contract-schema.js'

export interface RepositoryDelivery {
  delivery_id: string
  file_changes: FileChange[]
  case_ids: string[]
  case_count: number
}

export interface RepositoryCaseResult {
  case_id: string
  review_record: ReviewRecord
  disposition: string
  reason: string | null
}

export interface RepositoryWorkflowResult {
  contract_version: 'v4'
  scan_summary: Record<string, unknown>
  case_results: RepositoryCaseResult[]
  deliveries: RepositoryDelivery[]
}

function requirePublishableFileChanges (file_changes: FileChange[]): void {
  const seen = new Set<string>()
  for (const change of file_changes) {
    const normalizedPath = validateContractPublishableRepoRelativePath(change.path)
    if (seen.has(normalizedPath)) {
      throw new Error(`Delivery contains duplicate file change entries for ${normalizedPath}.`)
    }
    seen.add(normalizedPath)
  }
}

export function parseRepositoryWorkflowResult (value: unknown): RepositoryWorkflowResult {
  assertV4WorkflowResult('repository-review', value)
  const result = value as Omit<RepositoryWorkflowResult, 'deliveries'> & {
    deliveries: Array<Omit<RepositoryDelivery, 'case_count'>>
  }
  const deliveryIds = new Set<string>()
  for (const delivery of result.deliveries) {
    if (deliveryIds.has(delivery.delivery_id)) {
      throw new Error(`Repository result contains duplicate delivery_id: ${delivery.delivery_id}.`)
    }
    deliveryIds.add(delivery.delivery_id)
    requirePublishableFileChanges(delivery.file_changes)
  }
  return {
    ...result,
    deliveries: result.deliveries.map((delivery) => ({
      ...delivery,
      case_count: delivery.case_ids.length
    }))
  }
}
