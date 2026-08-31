export type AnyRecord = Record<string, unknown>

export function asList<T = unknown> (value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

export function isRecord (value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyText (value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function optionalNumber (value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function cvssSeverityRank (severity: unknown): number {
  switch (String(severity ?? '').toLowerCase()) {
    case 'critical':
      return 5
    case 'high':
      return 4
    case 'medium':
      return 3
    case 'low':
      return 2
    case 'none':
      return 1
    default:
      return 0
  }
}

export function displayText (value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return fallback
}

export function inlineCode (value: unknown, fallback = 'unknown'): string {
  return `\`${displayText(value, fallback).replace(/`/g, '\\`')}\``
}

export function formatFindingSummary (item: unknown): string {
  if (isRecord(item)) {
    return nonEmptyText(item.summary)
  }
  return nonEmptyText(item)
}

export function renderChangedFilesLines (
  changedFiles: unknown,
  options: { emptyText?: string } = {}
): string[] {
  const items = asList(changedFiles)
    .map((item) => nonEmptyText(item))
    .filter((item) => item.length > 0)

  if (items.length === 0) {
    return options.emptyText ? [options.emptyText] : []
  }

  return [
    'Changed files:',
    '',
    ...items.map((item) => `- ${inlineCode(item)}`)
  ]
}

export function renderLabeledListLines (
  label: string,
  items: unknown,
  formatter: (item: unknown) => string = nonEmptyText
): string[] {
  const lines = asList(items).map(formatter).filter((item) => item.length > 0)
  if (lines.length === 0) {
    return []
  }
  return [
    '',
    `${label}:`,
    ...lines.map((item) => `- ${item}`)
  ]
}

export interface VerificationSummaryLineOptions {
  fallback?: string
  includeHeadline?: boolean
  includeOverview?: boolean
  includeReviewTargetClaim?: boolean
  reviewTargetClaimFallback?: string
  includeUnknownResolutionNextStep?: boolean
  listItemFormatter?: (item: unknown) => string
}

export function renderVerificationSummaryLines (
  verification: AnyRecord,
  options: VerificationSummaryLineOptions = {}
): string[] {
  const fallback = options.fallback ?? 'No verification overview was recorded.'
  const listItemFormatter = options.listItemFormatter ?? formatFindingSummary
  const lines: string[] = []

  if (options.includeHeadline) {
    lines.push(
      `Verifier assessed patch=${nonEmptyText(verification.patch_coverage) || 'unknown'}.`,
      ''
    )
  }

  if (options.includeOverview !== false) {
    lines.push(nonEmptyText(verification.overview) || fallback, '')
  }

  lines.push(
    `- Patch coverage: ${inlineCode(verification.patch_coverage ?? 'unknown')}`,
    `- Regression status: ${inlineCode(verification.regression_status ?? 'unknown')}`
  )

  const resolutionNextStep = nonEmptyText(verification.resolution_next_step)
  if (resolutionNextStep || options.includeUnknownResolutionNextStep) {
    lines.push(
      `- Resolution next step: ${inlineCode(resolutionNextStep || 'unknown')}`
    )
  }

  lines.push(`- Validation level: ${inlineCode(verification.validation_level ?? 'unknown')}`)

  if (options.includeReviewTargetClaim !== false) {
    const reviewTargetClaim = nonEmptyText(verification.review_target_claim)
    if (reviewTargetClaim || options.reviewTargetClaimFallback !== undefined) {
      lines.push(
        '',
        'Review target claim:',
        '',
        reviewTargetClaim || options.reviewTargetClaimFallback || ''
      )
    }
  }

  lines.push(
    ...renderLabeledListLines(
      'Patch findings',
      verification.patch_findings,
      listItemFormatter
    ),
    ...renderLabeledListLines(
      'Verification findings',
      verification.verification_findings,
      listItemFormatter
    ),
    ...renderLabeledListLines(
      'Residual risks',
      verification.residual_risks,
      listItemFormatter
    )
  )

  return lines
}

function renderStringListSection (heading: string, values: unknown): string[] {
  const items = asList(values)
    .map((item) => nonEmptyText(item))
    .filter((item) => item.length > 0)

  if (items.length === 0) {
    return []
  }

  return [
    '',
    `${heading}:`,
    '',
    ...items.map((item) => `- ${item}`)
  ]
}

function renderLocationList (locations: unknown): string[] {
  const items = asList<AnyRecord>(locations).filter(isRecord)
  if (items.length === 0) {
    return []
  }

  return [
    '',
    'Locations:',
    '',
    ...items.map((item) => {
      const file = nonEmptyText(item.file)
      const line = typeof item.line === 'number' ? `:${item.line}` : ''
      const label = nonEmptyText(item.label)
      const anchor = file ? inlineCode(`${file}${line}`) : inlineCode('unknown')
      return label ? `- ${anchor}: ${label}` : `- ${anchor}`
    })
  ]
}

function renderReviewedNearbyPaths (paths: unknown): string[] {
  const items = asList<AnyRecord>(paths).filter(isRecord)
  if (items.length === 0) {
    return []
  }

  return [
    '',
    'Reviewed nearby paths:',
    '',
    ...items.map((item) => {
      const label = nonEmptyText(item.label) || 'unnamed path'
      const relationship = nonEmptyText(item.relationship) || 'unknown'
      const note = nonEmptyText(item.note)
      return note
        ? `- ${inlineCode(label)}: ${inlineCode(relationship)} - ${note}`
        : `- ${inlineCode(label)}: ${inlineCode(relationship)}`
    })
  ]
}

function renderControlReview (control_review: unknown): string[] {
  if (!isRecord(control_review)) {
    return []
  }

  const lines = [
    ...renderStringListSection('Reachable assets', control_review.reachable_assets),
    ...renderStringListSection('Security controls', control_review.security_controls),
    ...renderStringListSection('Control limits', control_review.control_limits)
  ]

  return lines.length > 0 ? ['', 'Control review:', ...lines] : []
}

function sortedAnalysisNarratives (narratives: unknown): AnyRecord[] {
  return asList<AnyRecord>(narratives)
    .filter(isRecord)
    .sort((left, right) => {
      const leftPriority = optionalNumber(left.priority) ?? Number.MAX_SAFE_INTEGER
      const rightPriority = optionalNumber(right.priority) ?? Number.MAX_SAFE_INTEGER
      return leftPriority - rightPriority
    })
}

function analysisNarrativeBodyLines (item: AnyRecord): string[] {
  const flow_review = isRecord(item.flow_review) ? item.flow_review : {}
  const support_review = isRecord(item.support_review) ? item.support_review : {}
  const scope_review = isRecord(item.scope_review) ? item.scope_review : {}
  const cwe_mapping = isRecord(item.cwe_mapping) ? item.cwe_mapping : {}
  const metaLines = [
    ['Verdict', item.verdict],
    ['Vulnerability type', item.vulnerability_type],
    ['Validation level', item.validation_level],
    ['Scope shape', scope_review.scope_shape],
    ['Shared boundary', scope_review.shared_boundary],
    ['CWE', [cwe_mapping.cwe_id, cwe_mapping.cwe_name].map(nonEmptyText).filter(Boolean).join(' - ')]
  ]
    .map(([key, value]) => [key, nonEmptyText(value)] as const)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `- ${key}: ${inlineCode(value)}`)

  const lines: string[] = []
  if (metaLines.length > 0) {
    lines.push(...metaLines, '')
  }

  const description = nonEmptyText(item.description)
  if (description) {
    lines.push(description, '')
  }

  lines.push(
    ...renderLocationList(item.locations),
    ...renderStringListSection('Source facts', flow_review.source_facts),
    ...renderStringListSection('Sink facts', flow_review.sink_facts),
    ...renderStringListSection('Supported inferences', support_review.supported_inferences),
    ...renderStringListSection('Proof gaps', support_review.proof_gaps),
    ...renderControlReview(item.control_review),
    ...renderReviewedNearbyPaths(scope_review.reviewed_nearby_paths)
  )

  const cwe_rationale = nonEmptyText(cwe_mapping.cwe_rationale)
  if (cwe_rationale) {
    lines.push('', 'CWE rationale:', '', cwe_rationale)
  }

  lines.push('')
  return lines
}

export function renderAnalysisNarratives (narratives: unknown): string[] {
  const items = sortedAnalysisNarratives(narratives)
  if (items.length === 0) {
    return []
  }

  const lines = ['Narratives:']
  for (const [index, item] of items.entries()) {
    const title = nonEmptyText(item.title)
    const label = title || `Narrative ${index + 1}`
    lines.push(`**${label}**`, ...analysisNarrativeBodyLines(item))
  }
  return lines
}
