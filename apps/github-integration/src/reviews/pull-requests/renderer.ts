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

function analysisHeadline (verdict: unknown): string {
  switch (verdict) {
    case 'no-actionable-finding': return 'no actionable security finding'
    case 'confirmed-vulnerability': return 'confirmed security vulnerability'
    case 'confirmed-defect': return 'confirmed security defect'
    case 'plausible-risk': return 'plausible security risk'
    case 'inconclusive': return 'inconclusive'
    default: return 'unknown'
  }
}

function mitigationHeadline (verdict: unknown, changedFiles: unknown[]): string {
  if (changedFiles.length > 0) {
    return `patch proposed, ${changedFiles.length} ${changedFiles.length === 1 ? 'file' : 'files'} changed`
  }
  return verdict === 'no-actionable-finding' ? 'not needed' : 'no patch proposed'
}

function verificationHeadline (validationLevel: unknown): string {
  switch (validationLevel) {
    case 'static': return 'static review'
    case 'logic-simulated': return 'logic simulation'
    case 'runtime-partial': return 'partial runtime validation'
    case 'runtime-endpoint': return 'runtime endpoint validation'
    default: return 'not recorded'
  }
}

function checksHeadline (regressionStatus: unknown): string {
  switch (regressionStatus) {
    case 'passed': return 'checks passed'
    case 'failed': return 'checks failed'
    case 'not-run': return 'checks not run'
    case 'not-applicable': return 'checks not applicable'
    case 'unresolved': return 'checks unresolved'
    default: return 'checks not recorded'
  }
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

  return renderVerificationSummaryLines({
    ...verification,
    resolution_next_step: verification.resolution_next_step === 'none'
      ? null
      : verification.resolution_next_step
  }, {
    includeOverview: false,
    reviewTargetClaimFallback: '(none)',
    includeUnknownResolutionNextStep: false
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
  const overview = displayText(analysis.overview, 'No overview provided.')
  const changed_files = asList(mitigation.changed_files)
  const resolution_next_step = displayText(verification.resolution_next_step, 'unknown')

  const lines = [
    '## PR Security Review',
    '',
    `- Analysis: ${inlineCode(analysisHeadline(analysis.verdict))}`,
    `- Mitigation: ${inlineCode(mitigationHeadline(analysis.verdict, changed_files))}`,
    `- Verification: ${inlineCode(`${verificationHeadline(verification.validation_level)}; ${checksHeadline(verification.regression_status)}`)}`,
    ...(resolution_next_step !== 'none'
      ? [`- Resolution next step: ${inlineCode(resolution_next_step)}`]
      : []),
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
