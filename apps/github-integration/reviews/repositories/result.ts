import type { FileChange, FileMode, TextEncoding } from '../file-change.js'
import { validateContractPublishableRepoRelativePath } from '../repo-path.js'
import { parseReviewRecord, type ReviewRecord } from '../review-record.js'
import { isRecord, nonEmptyText } from '../view-utils.js'

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

function requireRecord (value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`malformed v4 repository result: ${label} must be an object.`)
  }
  return value
}

function requireArray (value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`malformed v4 repository result: ${label} must be an array.`)
  }
  return value
}

function requireText (value: unknown, label: string): string {
  const text = nonEmptyText(value)
  if (!text) {
    throw new Error(`malformed v4 repository result: ${label} must be a non-empty string.`)
  }
  return text
}

function parseRepositoryCaseResults (value: unknown): RepositoryCaseResult[] {
  return requireArray(value, 'case_results').map((item, index) => {
    const caseResult = requireRecord(item, `case_results[${index}]`)
    return {
      case_id: requireText(caseResult.case_id, `case_results[${index}].case_id`),
      disposition: requireText(caseResult.disposition, `case_results[${index}].disposition`),
      reason: nonEmptyText(caseResult.reason) || null,
      review_record: parseReviewRecord(caseResult.review_record)
    }
  })
}

function parseRepositoryFileChanges (value: unknown, label: string): FileChange[] {
  const file_changes: FileChange[] = []
  const seen = new Set<string>()
  for (const [index, item] of requireArray(value, label).entries()) {
    const change = requireRecord(item, `${label}[${index}]`)
    const normalizedPath = validateContractPublishableRepoRelativePath(String(change.path ?? ''))
    if (!normalizedPath) {
      throw new Error('Delivery contains a file change without a path.')
    }
    if (seen.has(normalizedPath)) {
      throw new Error(`Delivery contains duplicate file change entries for ${normalizedPath}.`)
    }

    const status = String(change.status ?? '').trim().toLowerCase()
    const content_encoding = String(change.content_encoding ?? '').trim().toLowerCase()
    const content = typeof change.content === 'string' ? change.content : undefined
    const rawMode = String(change.mode ?? '').trim()
    const mode: FileMode | undefined = rawMode === '100644' || rawMode === '100755'
      ? rawMode
      : undefined

    if (!['upsert', 'deleted'].includes(status)) {
      throw new Error(`Delivery has unsupported file change status for ${normalizedPath}: ${status || '(missing)'}`)
    }
    if (rawMode && typeof mode === 'undefined') {
      throw new Error(`Delivery has unsupported file mode for ${normalizedPath}: ${rawMode}`)
    }
    if (status === 'deleted' && typeof content !== 'undefined') {
      throw new Error(`Delivery marked ${normalizedPath} deleted but also included content.`)
    }
    if (status === 'deleted' && change.content_encoding) {
      throw new Error(`Delivery marked ${normalizedPath} deleted but also included a content_encoding.`)
    }
    if (status === 'deleted' && rawMode) {
      throw new Error(`Delivery marked ${normalizedPath} deleted but also included a mode.`)
    }
    if (status === 'upsert' && typeof content !== 'string') {
      throw new Error(`Delivery is missing file change content for ${normalizedPath}.`)
    }
    if (status === 'upsert' && !['utf-8', 'base64'].includes(content_encoding)) {
      throw new Error(`Delivery has unsupported file change encoding for ${normalizedPath}: ${content_encoding}`)
    }

    seen.add(normalizedPath)
    if (status === 'deleted') {
      file_changes.push({
        path: normalizedPath,
        status: 'deleted'
      })
      continue
    }

    if (typeof content !== 'string') {
      throw new Error(`Delivery is missing file change content for ${normalizedPath}.`)
    }
    const normalizedEncoding: TextEncoding = content_encoding === 'base64' ? 'base64' : 'utf-8'
    file_changes.push({
      path: normalizedPath,
      status: 'upsert',
      content_encoding: normalizedEncoding,
      content,
      ...(mode ? { mode } : {})
    })
  }

  return file_changes
}

function parseDeliveryCaseIds (value: unknown, label: string): string[] {
  return requireArray(value, label)
    .map((item, index) => requireText(item, `${label}[${index}]`))
}

function parseRepositoryDelivery (value: unknown, index: number): RepositoryDelivery {
  const delivery = requireRecord(value, `deliveries[${index}]`)
  const case_ids = parseDeliveryCaseIds(delivery.case_ids, `deliveries[${index}].case_ids`)
  return {
    delivery_id: requireText(delivery.delivery_id, `deliveries[${index}].delivery_id`),
    file_changes: parseRepositoryFileChanges(delivery.file_changes, `deliveries[${index}].file_changes`),
    case_ids,
    case_count: case_ids.length
  }
}

export function parseRepositoryWorkflowResult (value: unknown): RepositoryWorkflowResult {
  const rawResult = requireRecord(value, 'result')
  if (rawResult.contract_version !== 'v4') {
    throw new Error('malformed v4 repository result: contract_version must be v4.')
  }
  return {
    contract_version: 'v4',
    scan_summary: requireRecord(rawResult.scan_summary, 'scan_summary'),
    deliveries: requireArray(rawResult.deliveries, 'deliveries').map(parseRepositoryDelivery),
    case_results: parseRepositoryCaseResults(rawResult.case_results)
  }
}
