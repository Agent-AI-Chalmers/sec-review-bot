import { type ContractVersion } from '../../execution/contract-version.js'
import type { FileChange } from '../file-change.js'
import { validateContractPublishableRepoRelativePath } from '../repo-path.js'
import type { ReviewRecord } from '../review-record.js'
import { assertWorkflowResult } from '../../execution/contract-schema.js'

// Consumer-side view for repository delivery publishing. Unlike the JSON Schema, this
// intentionally lists only fields this integration reads; add another public field here
// only when a concrete call site needs it.
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

export interface RepositoryScanSummary {
  scannable_file_count: number
  scanned_file_count: number
  skipped_file_count: number
  candidate_count: number
  case_count: number
  suppressed_candidate_count: number
  deleted_file_count: number
}

export interface RepositoryWorkflowResult {
  contract_version: ContractVersion
  scan_summary: RepositoryScanSummary
  case_results: RepositoryCaseResult[]
  deliveries: RepositoryDelivery[]
  // True when the window removed more files than deletion review covers. The schema makes it
  // required, and the published comment has to show it: an unreviewed window otherwise reads
  // exactly like a reviewed one.
  deletion_review_skipped: boolean
}

function requirePublishableFileChanges(file_changes: FileChange[]): void {
  const seen = new Set<string>()
  for (const change of file_changes) {
    const normalizedPath = validateContractPublishableRepoRelativePath(
      change.path
    )
    if (seen.has(normalizedPath)) {
      throw new Error(
        `Delivery contains duplicate file change entries for ${normalizedPath}.`
      )
    }
    seen.add(normalizedPath)
  }
}

export function parseRepositoryWorkflowResult(
  value: unknown
): RepositoryWorkflowResult {
  assertWorkflowResult('repository-review', value)
  const result = value as Omit<RepositoryWorkflowResult, 'deliveries'> & {
    deliveries: Array<Omit<RepositoryDelivery, 'case_count'>>
  }
  const deliveryIds = new Set<string>()
  for (const delivery of result.deliveries) {
    if (deliveryIds.has(delivery.delivery_id)) {
      throw new Error(
        `Repository result contains duplicate delivery_id: ${delivery.delivery_id}.`
      )
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
