import {
  cvssSeverityRank,
  inlineCode,
  nonEmptyText,
  renderAnalysisNarratives,
  renderChangedFilesLines,
  renderReviewStatusLines,
  renderVerificationSummaryLines
} from '../view-utils.js'
import { fileChangePaths } from '../file-change.js'
import type { ReviewRecord } from '../review-record.js'
import type {
  RepositoryCaseResult,
  RepositoryDelivery,
  RepositoryScanSummary,
  RepositoryWorkflowResult
} from './result.js'

export const REPOSITORY_SECURITY_SUMMARY_ISSUE_TITLE =
  '[sec-review-bot] Repository Security Review Summary'

interface RepoLike {
  owner_login?: string
  repo_name?: string
  repo_full_name?: string
}

interface PublishedDeliveryEntryLike {
  delivery_id: string
  case_count: number
  cvss_outcome: string | null
  cvss_base_score: number | null
  cvss_severity: string | null
  title: string
  html_url: string
  file_changes: RepositoryDelivery['file_changes']
}

interface CvssSummary {
  scored_case_count: number
  not_scored_case_count: number
  unscored_case_count: number
  severity_counts: Record<string, number>
}

interface RepositorySummaryWorkflowView {
  run_id: string
  deletion_review_skipped: boolean
  scan_summary: RepositoryScanSummary
  cvss_summary: CvssSummary
  case_results: RepositoryCaseResult[]
}

interface RepositoryScanTargetLike {
  scan_mode?: unknown
  base_sha?: unknown
  head_sha?: unknown
}

function caseResultsById(
  case_results: RepositoryCaseResult[]
): Map<string, RepositoryCaseResult> {
  const indexed = new Map<string, RepositoryCaseResult>()
  for (const item of case_results) {
    if (!indexed.has(item.case_id)) {
      indexed.set(item.case_id, item)
    }
  }
  return indexed
}

function renderFoldedBlock(summary: string, bodyLines: string[]): string[] {
  if (!bodyLines.some((line) => nonEmptyText(line).length > 0)) {
    return []
  }
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    ...bodyLines,
    '',
    '</details>'
  ]
}

function parseCvssBaseVector(vector: unknown): Record<string, string> {
  const parsed: Record<string, string> = {}
  const raw = String(vector ?? '').trim()
  if (!raw) {
    return parsed
  }

  for (const part of raw.split('/')) {
    const idx = part.indexOf(':')
    if (idx <= 0) {
      continue
    }
    const key = part.slice(0, idx)
    const value = part.slice(idx + 1)
    parsed[key] = value
  }
  return parsed
}

function formatCvssKeyMetrics(vector: unknown): string {
  const parsed = parseCvssBaseVector(vector)
  const metrics = ['AV', 'AC', 'AT', 'PR', 'UI']
  return metrics.map((key) => `${key}=${parsed[key] ?? '?'}`).join(', ')
}

function buildCvssSummaryFromCases(
  case_results: RepositoryCaseResult[]
): CvssSummary {
  const severity_counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
    unknown: 0
  }
  let scored_case_count = 0
  let not_scored_case_count = 0

  for (const item of case_results) {
    const cvss = item.review_record.cvss
    if (cvss === null) {
      continue
    }

    const outcome = cvss.outcome
    if (outcome === 'not-scored') {
      not_scored_case_count += 1
    }

    const base_score = cvss.base_score
    if (base_score != null) {
      scored_case_count += 1
      const severity = cvss.severity?.toLowerCase() || 'unknown'
      const severity_key = severity in severity_counts ? severity : 'unknown'
      severity_counts[severity_key] = (severity_counts[severity_key] ?? 0) + 1
    }
  }

  return {
    scored_case_count,
    not_scored_case_count,
    unscored_case_count: Math.max(0, case_results.length - scored_case_count),
    severity_counts
  }
}

export function buildRepositorySummaryWorkflowView(
  workflow_result: RepositoryWorkflowResult,
  options: { run_id?: string } = {}
): RepositorySummaryWorkflowView {
  const view: RepositorySummaryWorkflowView = {
    run_id: options.run_id ?? 'unknown',
    scan_summary: workflow_result.scan_summary,
    deletion_review_skipped: workflow_result.deletion_review_skipped,
    case_results: workflow_result.case_results,
    cvss_summary: buildCvssSummaryFromCases(workflow_result.case_results)
  }
  return view
}

function renderCvssScoringSection(cvss: ReviewRecord['cvss']): string[] {
  if (cvss === null) {
    return ['#### CVSS', '', 'No CVSS score was recorded.', '']
  }
  const outcome = cvss.outcome
  const overview = String(
    cvss.overview ?? 'No CVSS scoring overview was recorded.'
  )
  if (outcome === 'not-scored') {
    return [
      '#### CVSS',
      '',
      '- Outcome: `not-scored`',
      '',
      String(
        cvss.not_scored_reason ??
          'Current case is not independently CVSS-scoreable.'
      ),
      ''
    ]
  }
  if (outcome && outcome !== 'scored') {
    return ['#### CVSS', '', overview, '', `- Outcome: \`${outcome}\``, '']
  }
  return [
    '#### CVSS',
    '',
    overview,
    '',
    `- Base score: ${inlineCode(cvss.base_score ?? 'n/a')} (${inlineCode(cvss.severity ?? 'unknown')})`,
    `- Vector: ${inlineCode(cvss.vector ?? 'unknown')}`,
    `- Key metrics: ${inlineCode(formatCvssKeyMetrics(cvss.vector))}`,
    ''
  ]
}

function renderCvssScoringBody(cvss: ReviewRecord['cvss']): string[] {
  const section = renderCvssScoringSection(cvss)
  if (section[0] === '#### CVSS' && section[1] === '') {
    return section.slice(2)
  }
  return section
}

function sortDeliveriesByRisk(
  deliveries: PublishedDeliveryEntryLike[]
): PublishedDeliveryEntryLike[] {
  return [...deliveries].sort((a, b) => {
    const scoreA = a.cvss_base_score ?? -1
    const scoreB = b.cvss_base_score ?? -1
    if (scoreA !== scoreB) {
      return scoreB - scoreA
    }

    const severityA = cvssSeverityRank(a.cvss_severity)
    const severityB = cvssSeverityRank(b.cvss_severity)
    if (severityA !== severityB) {
      return severityB - severityA
    }

    const countA = a.case_count
    const countB = b.case_count
    if (countA !== countB) {
      return countB - countA
    }

    return a.title.localeCompare(b.title)
  })
}

function deliverySeverityKey(delivery: PublishedDeliveryEntryLike): string {
  const outcome = delivery.cvss_outcome
  if (outcome === 'not-scored') {
    return 'not-scored'
  }
  const score = delivery.cvss_base_score
  if (score == null) {
    return outcome && outcome !== 'scored' ? outcome : 'unscored'
  }
  return (
    String(delivery.cvss_severity ?? 'unknown')
      .trim()
      .toLowerCase() || 'unknown'
  )
}

function formatDeliveryCvssBadge(delivery: PublishedDeliveryEntryLike): string {
  const outcome = delivery.cvss_outcome
  if (outcome === 'not-scored') {
    return 'CVSS not-scored'
  }
  const score = delivery.cvss_base_score
  if (score != null) {
    return `CVSS ${score.toFixed(1)}`
  }
  return outcome && outcome !== 'scored' ? `CVSS ${outcome}` : 'CVSS unscored'
}

function sortSeverityKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const rankDiff = cvssSeverityRank(b) - cvssSeverityRank(a)
    if (rankDiff !== 0) {
      return rankDiff
    }
    return a.localeCompare(b)
  })
}

function deliveryIdForDelivery(delivery: PublishedDeliveryEntryLike): string {
  return delivery.delivery_id
}

function coordinationNotesForDeliveries(
  deliveries: PublishedDeliveryEntryLike[]
): string[] {
  const byFile = new Map<string, PublishedDeliveryEntryLike[]>()
  for (const delivery of deliveries) {
    for (const filePath of fileChangePaths(delivery.file_changes)) {
      const items = byFile.get(filePath) ?? []
      items.push(delivery)
      byFile.set(filePath, items)
    }
  }

  const notes: string[] = []
  for (const [filePath, items] of [...byFile.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    if (items.length < 2) {
      continue
    }
    const links = items
      .sort((left, right) =>
        deliveryIdForDelivery(left).localeCompare(deliveryIdForDelivery(right))
      )
      .map((item) => {
        const label = deliveryIdForDelivery(item)
        return `[${inlineCode(label)}](${item.html_url})`
      })
      .join(', ')
    notes.push(
      `Shared modified file ${inlineCode(filePath)}: ${links}. These delivery PRs touch the same file; review publish order if publishing them together.`
    )
  }
  return notes
}

function renderMitigationSummaryLines(
  mitigation: ReviewRecord['mitigation'],
  fallback: string,
  options: { includeReferencePatch?: boolean } = {}
): string[] {
  return [
    nonEmptyText(mitigation.overview) || fallback,
    ...(options.includeReferencePatch
      ? renderReferencePatch(mitigation.patch_diff)
      : [])
  ]
}

function compactText(value: unknown, maxChars = 180): string {
  const text = nonEmptyText(value)
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`
}

function blockedConfirmedCaseTitle(
  case_id: string,
  analysis: ReviewRecord['analysis'],
  cvss: ReviewRecord['cvss']
): string {
  const severity = cvss?.severity || 'unscored'
  const overview = compactText(analysis.overview, 96)
  const suffix = overview || 'confirmed but not fully verified'
  return `[${severity}] ${case_id} — ${suffix}`
}

function renderReferencePatch(patch_diff: unknown): string[] {
  const patch = String(patch_diff ?? '').trim()
  if (!patch) {
    return []
  }
  const maxPatchChars = 12000
  const truncated = patch.length > maxPatchChars
  const visiblePatch = truncated
    ? `${patch.slice(0, maxPatchChars).trimEnd()}\n\n[sec-review-bot: reference patch truncated for summary comment.]`
    : patch
  return [
    '',
    '<details>',
    '<summary>Reference patch</summary>',
    '',
    '```diff',
    visiblePatch,
    '```',
    '',
    '</details>'
  ]
}

function isBlockedConfirmedCase(caseResult: RepositoryCaseResult): boolean {
  if (caseResult.disposition === 'keep') {
    return false
  }
  return [
    'confirmed-defect',
    'confirmed-vulnerability',
    'plausible-risk'
  ].includes(caseResult.review_record.analysis.verdict ?? '')
}

function renderBlockedConfirmedCases(
  case_results: RepositoryCaseResult[]
): string[] {
  const blocks: string[] = []
  for (const caseResult of case_results) {
    if (!isBlockedConfirmedCase(caseResult)) {
      continue
    }

    const { analysis, mitigation, verification, cvss } =
      caseResult.review_record
    const case_id = caseResult.case_id
    const dispositionReason =
      nonEmptyText(caseResult.reason) || 'No verified fix was produced.'

    const body = [
      // The status lines belong in the card body so the title only carries case
      // identity; the title used to repeat the coverage rating as a suffix.
      ...renderReviewStatusLines({ analysis, mitigation, verification }),
      '',
      ...renderFoldedBlock('Analysis', [
        nonEmptyText(analysis.overview) ||
          'Analyzer confirmed this case, but no analysis overview was recorded.',
        '',
        ...renderAnalysisNarratives(analysis.narratives)
      ]),
      ...renderFoldedBlock('CVSS', renderCvssScoringBody(cvss)),
      ...renderFoldedBlock(
        'Mitigation',
        renderMitigationSummaryLines(mitigation, dispositionReason, {
          includeReferencePatch: true
        })
      ),
      ...renderFoldedBlock(
        'Verification',
        renderVerificationSummaryLines(verification, {
          fallback: dispositionReason
        })
      )
    ]

    blocks.push(
      ...renderFoldedBlock(
        blockedConfirmedCaseTitle(case_id, analysis, cvss),
        body
      )
    )
  }
  return blocks
}

export function buildRepoReviewSummaryBody({
  repo
}: {
  repo: RepoLike
}): string {
  const repo_full_name =
    typeof repo.repo_full_name === 'string'
      ? repo.repo_full_name
      : 'unknown/unknown'
  return [
    '# Repository Security Review Summary',
    '',
    `This issue is the long-lived summary surface for automated repository security scans in ${inlineCode(repo_full_name)}.`,
    '',
    'Each scan appends one comment with:',
    '- discovery / triage counts',
    '- cases',
    '- published repository delivery draft PRs for publishable mitigations',
    '',
    'Older comments remain useful as an audit trail.'
  ].join('\n')
}

export function renderRepositorySecuritySummaryComment({
  workflow_result,
  published_delivery_entries,
  event_type,
  target_branch,
  scan_target
}: {
  workflow_result: RepositorySummaryWorkflowView
  published_delivery_entries: PublishedDeliveryEntryLike[]
  event_type: 'manual' | 'scheduled'
  target_branch: string
  scan_target?: RepositoryScanTargetLike
}): string {
  const case_results = workflow_result.case_results
  const cvss_summary = workflow_result.cvss_summary
  const cvss_severity_counts = cvss_summary.severity_counts
  const blockedConfirmedCaseBlocks = renderBlockedConfirmedCases(case_results)
  const blockedConfirmedCaseCount = case_results.filter(
    isBlockedConfirmedCase
  ).length
  const keep_case_count = case_results.filter(
    (item) => String(item?.disposition ?? '') === 'keep'
  ).length
  const scan_summary = workflow_result.scan_summary
  const scan_mode = String(scan_target?.scan_mode ?? 'full').trim() || 'full'
  const base_sha = String(scan_target?.base_sha ?? '').trim()
  const head_sha = String(scan_target?.head_sha ?? '').trim()

  const scanSummaryLines = [
    `- Scan mode: ${inlineCode(scan_mode)}`,
    `- Scannable files: ${inlineCode(scan_summary.scannable_file_count ?? 0)}`,
    `- Scanned files: ${inlineCode(scan_summary.scanned_file_count ?? 0)}`,
    `- Skipped files: ${inlineCode(scan_summary.skipped_file_count ?? 0)}`,
    `- Discovery candidates: ${inlineCode(scan_summary.candidate_count ?? 0)}`,
    `- Lightweight cases after triage: ${inlineCode(scan_summary.case_count ?? 0)}`,
    `- Suppressed candidates: ${inlineCode(scan_summary.suppressed_candidate_count ?? 0)}`,
    `- Deleted files in window: ${inlineCode(scan_summary.deleted_file_count ?? 0)}`,
    `- Keep cases: ${inlineCode(keep_case_count)}`,
    `- Blocked confirmed cases: ${inlineCode(blockedConfirmedCaseCount)}`,
    `- Delivery PRs published this run: ${inlineCode(published_delivery_entries.length)}`,
    `- CVSS scored cases: ${inlineCode(cvss_summary.scored_case_count ?? 0)}`,
    `- CVSS not-scored cases: ${inlineCode(cvss_summary.not_scored_case_count ?? 0)}`
  ]

  const lines = [
    '## Repository Security Review',
    '',
    `**Trigger:** \`${event_type}\``,
    `**Branch:** \`${target_branch}\``,
    `**Run ID:** \`${workflow_result.run_id}\``,
    '',
    '### Scan Summary',
    ''
  ]

  // Shown above the summary, not folded into it: a run whose deletions were never reviewed is a
  // partial result, and a reader who skims this comment must not take it for a complete one.
  if (workflow_result?.deletion_review_skipped === true) {
    lines.push(
      `> **Deletion review skipped.** This window deleted \`${scan_summary.deleted_file_count ?? 0}\` files, above the review limit, so none of them were reviewed. Narrow the window to cover them.`,
      ''
    )
  }

  scanSummaryLines.push(
    `- Case CVSS severities: ${inlineCode(`critical=${cvss_severity_counts.critical ?? 0}`)}, ` +
      `${inlineCode(`high=${cvss_severity_counts.high ?? 0}`)}, ` +
      `${inlineCode(`medium=${cvss_severity_counts.medium ?? 0}`)}, ` +
      `${inlineCode(`low=${cvss_severity_counts.low ?? 0}`)}, ` +
      `${inlineCode(`none=${cvss_severity_counts.none ?? 0}`)}`
  )

  if (base_sha) {
    scanSummaryLines.push(`- Base sha: ${inlineCode(base_sha)}`)
  }
  if (head_sha) {
    scanSummaryLines.push(`- Head sha: ${inlineCode(head_sha)}`)
  }

  lines.push(...renderFoldedBlock('Scan summary details', scanSummaryLines))

  const normalizedDeliveryEntries = published_delivery_entries

  if (normalizedDeliveryEntries.length > 0) {
    lines.push('', '### Published Delivery PRs', '')
    lines.push(
      "_Grouped by each delivery PR's highest case CVSS severity._",
      ''
    )
    const sortedDeliveryEntries = sortDeliveriesByRisk(
      normalizedDeliveryEntries
    )
    const deliveryEntriesBySeverity = new Map<
      string,
      PublishedDeliveryEntryLike[]
    >()

    for (const item of sortedDeliveryEntries) {
      const severityKey = deliverySeverityKey(item)
      if (!deliveryEntriesBySeverity.has(severityKey)) {
        deliveryEntriesBySeverity.set(severityKey, [])
      }
      deliveryEntriesBySeverity.get(severityKey)?.push(item)
    }

    for (const severityKey of sortSeverityKeys([
      ...deliveryEntriesBySeverity.keys()
    ])) {
      const group = deliveryEntriesBySeverity.get(severityKey) ?? []
      lines.push(`#### ${severityKey} (${group.length})`, '')
      for (const [index, item] of group.entries()) {
        const case_count = Number(item.case_count ?? 0)
        lines.push(
          `${index + 1}. [${formatDeliveryCvssBadge(item)}] ${item.title} (cases=${case_count}): ${item.html_url}`
        )
      }
      lines.push('')
    }
    const coordinationNotes = coordinationNotesForDeliveries(
      normalizedDeliveryEntries
    )
    if (coordinationNotes.length > 0) {
      lines.push(
        '### Coordination Notes',
        '',
        ...coordinationNotes.map((item) => `- ${item}`),
        ''
      )
    }
  }

  if (blockedConfirmedCaseBlocks.length > 0) {
    lines.push(
      '',
      '### Blocked Confirmed Cases',
      '',
      ...blockedConfirmedCaseBlocks
    )
  }

  return lines.join('\n')
}

export function buildDeliveryDraftPrBody({
  repo,
  delivery,
  case_results = []
}: {
  repo: RepoLike
  delivery: RepositoryDelivery
  case_results?: RepositoryCaseResult[]
}): string {
  const repo_full_name =
    typeof repo.repo_full_name === 'string'
      ? repo.repo_full_name
      : 'unknown/unknown'
  const changed_files = fileChangePaths(delivery.file_changes)
  const case_ids = delivery.case_ids
  const case_count = delivery.case_count
  const primaryCaseId = case_ids[0] ?? 'unknown'
  const casesById = caseResultsById(case_results)

  const lines = [
    `<!-- sec-review-bot-delivery-id: ${delivery.delivery_id} -->`,
    `<!-- sec-review-bot-case-count: ${case_count} -->`,
    `<!-- sec-review-bot-primary-case-id: ${primaryCaseId} -->`,
    '',
    `This PR applies security mitigations for ${inlineCode(case_count)} confirmed case(s) in ${inlineCode(repo_full_name)}.`,
    ''
  ]

  lines.push('', '## Modified Files', '')

  if (changed_files.length > 0) {
    lines.push(...renderChangedFilesLines(changed_files).slice(2))
  } else {
    lines.push('- No modified files were recorded.')
  }

  const caseDetails = case_ids.flatMap((case_id) => {
    const caseResult = casesById.get(case_id)
    if (!caseResult) {
      return []
    }
    const { analysis, mitigation, verification, cvss } =
      caseResult.review_record
    const body = [
      `### Case ${inlineCode(case_id)}`,
      '',
      ...renderReviewStatusLines(
        { analysis, mitigation, verification },
        { includeResolutionNextStep: true }
      ),
      '',
      ...renderFoldedBlock('Analysis', [
        nonEmptyText(analysis.overview) || 'No analyzer overview was recorded.',
        '',
        ...renderAnalysisNarratives(analysis.narratives)
      ]),
      ...renderFoldedBlock('CVSS', renderCvssScoringBody(cvss)),
      ...renderFoldedBlock(
        'Mitigation',
        renderMitigationSummaryLines(
          mitigation,
          'No mitigation overview was recorded.'
        )
      ),
      ...renderFoldedBlock(
        'Verification',
        renderVerificationSummaryLines(verification, {
          fallback: 'No verification overview was recorded.'
        })
      )
    ]
    return renderFoldedBlock(`View case ${case_id}`, body)
  })

  if (caseDetails.length > 0) {
    lines.push(
      '',
      '## Case Details',
      '',
      '_The following sections summarize case-level stage outputs. For combined deliveries, the final PR diff is authoritative._',
      '',
      ...caseDetails
    )
  } else if (case_ids.length > 0) {
    lines.push(
      '',
      '## Cases',
      '',
      '_For combined deliveries, the final PR diff is authoritative._',
      ''
    )
    lines.push(...case_ids.map((case_id) => `- ${inlineCode(case_id)}`))
  }

  return lines.join('\n')
}
