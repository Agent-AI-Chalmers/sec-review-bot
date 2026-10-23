import { fileChangePaths } from '../file-change.js'
import type { RepositoryDelivery } from './result.js'

function isDocumentationPath(value: string): boolean {
  const lower = value.toLowerCase()
  return (
    lower === 'readme.md' ||
    lower.endsWith('/readme.md') ||
    lower.endsWith('.md')
  )
}

function primaryFileForDeliveryTitle(delivery: RepositoryDelivery): string {
  const changed_files = fileChangePaths(delivery.file_changes)
  return (
    changed_files.find((item) => !isDocumentationPath(item)) ??
    changed_files[0] ??
    ''
  )
}

function titleDisambiguator(delivery: RepositoryDelivery): string {
  return delivery.case_ids[0] ?? delivery.delivery_id
}

function deliveryTitleSuffix(delivery: RepositoryDelivery): string {
  const case_count = delivery.case_count
  const disambiguator = titleDisambiguator(delivery)
  if (case_count <= 1) {
    return disambiguator ? ` (${disambiguator})` : ''
  }
  const relatedCount = case_count - 1
  const related = `+${relatedCount} related case${relatedCount === 1 ? '' : 's'}`
  return ` (${[disambiguator, related].filter(Boolean).join(' ')})`
}

export function buildDeliveryDraftPrTitle(
  delivery: RepositoryDelivery
): string {
  const primaryFile = primaryFileForDeliveryTitle(delivery)
  const suffix = deliveryTitleSuffix(delivery)
  if (primaryFile) {
    return `[sec] Fix security issue in ${primaryFile}${suffix}`
  }
  return `[sec] Repository security mitigation${suffix}`
}
