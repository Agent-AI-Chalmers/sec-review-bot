import type { ReviewRecord } from '../review-record.js'
import {
  asList,
  displayText,
  inlineCode,
  renderAnalysisNarratives,
  renderChangedFilesLines,
  renderVerificationSummaryLines
} from '../view-utils.js'

function asNonEmptyString (value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value
    : null
}

function renderFoldedSection (summary: string, body: string | null): string | null {
  if (!body) {
    return null
  }

  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    body,
    '',
    '</details>'
  ].join('\n')
}

function joinParagraphBlocks (blocks: Array<string | null>): string {
  return blocks.filter((item): item is string => Boolean(item)).join('\n\n')
}

function renderMitigationSection (mitigation: ReviewRecord['mitigation']): string | null {
  const overview = asNonEmptyString(mitigation.overview)
  const changed_files = mitigation.changed_files

  if (!overview && changed_files.length === 0) {
    return null
  }

  const changedFilesBlock = changed_files.length > 0
    ? renderChangedFilesLines(changed_files).join('\n')
    : null

  return joinParagraphBlocks([
    overview,
    changedFilesBlock
  ])
}

function renderAnalysisSection (analysis: ReviewRecord['analysis']): string | null {
  const narrativesSection = renderAnalysisNarratives(analysis.narratives)
  const overview = displayText(analysis.overview, 'No overview provided.')

  if (!analysis.verdict && !overview && narrativesSection.length === 0) {
    return null
  }

  return joinParagraphBlocks([
    [
      `- Verdict: ${inlineCode(displayText(analysis.verdict, 'unknown'))}`
    ].join('\n'),
    overview,
    narrativesSection.length > 0 ? narrativesSection.join('\n') : null
  ])
}

function renderVerificationSection (verification: ReviewRecord['verification']): string | null {
  if (!verification.patch_coverage) {
    return null
  }

  return renderVerificationSummaryLines(verification, {
    includeOverview: false,
    reviewTargetClaimFallback: '(none)',
    includeUnknownResolutionNextStep: true
  }).join('\n')
}

export function renderAnalysisSummaryCommentFromReviewRecord (
  review_record: ReviewRecord | null | undefined
): string {
  const analysis = review_record?.analysis ?? {
    verdict: null,
    overview: null,
    narratives: []
  }
  const mitigation = review_record?.mitigation ?? {
    overview: null,
    changed_files: [],
    file_changes: [],
    patch_diff: null
  }
  const verification = review_record?.verification ?? {
    overview: null,
    review_target_claim: null,
    validation_level: null,
    patch_coverage: null,
    regression_status: null,
    resolution_next_step: null,
    patch_findings: [],
    verification_findings: [],
    residual_risks: []
  }
  const verdict = displayText(analysis.verdict, 'unknown')
  const overview = displayText(analysis.overview, 'No overview provided.')
  const changed_files = asList(mitigation.changed_files)
  const verificationAssessment = displayText(verification.patch_coverage, 'unknown')
  const resolution_next_step = displayText(verification.resolution_next_step, 'unknown')

  const lines = [
    '## PR Security Review',
    '',
    `- Verdict: ${inlineCode(verdict)}`,
    `- Changed files: ${inlineCode(String(changed_files.length))}`,
    `- Verification: ${inlineCode(verificationAssessment)}`,
    `- Resolution next step: ${inlineCode(resolution_next_step)}`,
    '',
    overview
  ]
  const analysisSection = renderAnalysisSection(analysis)
  const mitigationSection = renderMitigationSection(mitigation)
  const verificationSection = renderVerificationSection(verification)

  if (analysisSection) {
    lines.push('', renderFoldedSection('Analysis', analysisSection) ?? '')
  }
  if (mitigationSection) {
    lines.push('', renderFoldedSection('Mitigation', mitigationSection) ?? '')
  }
  if (verificationSection) {
    lines.push('', renderFoldedSection('Verification', verificationSection) ?? '')
  }

  return lines
    .filter((item) => item !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}
