import { fileChangePaths } from '../file-change.js'
import { asList, optionalNumber } from '../view-utils.js'

interface DeliveryTitleSource {
  case_count?: unknown
  case_ids?: unknown[]
  delivery_id?: unknown
  file_changes?: unknown[]
}

function isDocumentationPath (value: string): boolean {
  const lower = value.toLowerCase()
  return lower === 'readme.md' || lower.endsWith('/readme.md') || lower.endsWith('.md')
}

function primaryFileForDeliveryTitle (delivery: DeliveryTitleSource): string {
  const changed_files = fileChangePaths(delivery.file_changes)
  return changed_files.find((item) => !isDocumentationPath(item)) ?? changed_files[0] ?? ''
}

function titleDisambiguator (delivery: DeliveryTitleSource): string {
  const firstCaseId = asList(delivery.case_ids)
    .map((item) => String(item ?? '').trim())
    .find((item) => item.length > 0)
  const delivery_id = String(delivery.delivery_id ?? '').trim()
  return firstCaseId || delivery_id
}

function deliveryTitleSuffix (delivery: DeliveryTitleSource): string {
  const case_count = optionalNumber(delivery.case_count) ?? asList(delivery.case_ids).length
  const disambiguator = titleDisambiguator(delivery)
  if (case_count <= 1) {
    return disambiguator ? ` (${disambiguator})` : ''
  }
  const relatedCount = case_count - 1
  const related = `+${relatedCount} related case${relatedCount === 1 ? '' : 's'}`
  return ` (${[disambiguator, related].filter(Boolean).join(' ')})`
}

export function buildDeliveryDraftPrTitle (delivery: unknown): string {
  const normalizedDelivery = (delivery ?? {}) as DeliveryTitleSource
  const primaryFile = primaryFileForDeliveryTitle(normalizedDelivery)
  const suffix = deliveryTitleSuffix(normalizedDelivery)
  if (primaryFile) {
    return `[sec] Fix security issue in ${primaryFile}${suffix}`
  }
  return `[sec] Repository security mitigation${suffix}`
}
