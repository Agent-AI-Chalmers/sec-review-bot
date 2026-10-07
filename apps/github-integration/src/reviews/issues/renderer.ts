import type { ReviewRecord } from '../review-record.js'
import { validateRepoRelativePath } from '../repo-path.js'
import {
  asList,
  inlineCode,
  isRecord,
  renderAnalysisNarratives,
  renderChangedFilesLines,
  renderVerificationSummaryLines
} from '../view-utils.js'

interface IssueLike {
  issue_number: number
  issue_title?: string
}

interface DraftPullRequestLike {
  number?: number
  html_url?: string
}

interface DraftPrPlanLike {
  recommended_action?: string
  patch_ready?: boolean
  title?: string
  changed_files?: string[]
  patch_preview?: string | null
  sections?: {
    summary?: string[]
    code_changes?: string[]
    verification?: string[]
    residual_risks?: string[]
  }
}

const EMPTY_ANALYSIS: ReviewRecord['analysis'] = {
  verdict: null,
  overview: null,
  narratives: []
}

const EMPTY_MITIGATION: ReviewRecord['mitigation'] = {
  overview: null,
  changed_files: [],
  file_changes: [],
  patch_diff: null
}

const EMPTY_VERIFICATION: ReviewRecord['verification'] = {
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

function uniqueNonEmptyStrings (items: unknown, limit = Infinity): string[] {
  const seen = new Set<string>()
  const normalizedItems: string[] = []

  for (const item of asList(items)) {
    const normalized = String(item ?? '').trim()

    if (!normalized) {
      continue
    }

    const dedupeKey = normalized.toLowerCase()

    if (seen.has(dedupeKey)) {
      continue
    }

    seen.add(dedupeKey)
    normalizedItems.push(normalized)

    if (normalizedItems.length >= limit) {
      break
    }
  }

  return normalizedItems
}

function asNonEmptyString (value: unknown): string {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : ''
}

function buildVerifierHeadline (verification: unknown): string {
  const safeVerifier = isRecord(verification) ? verification : {}
  const patch_coverage = asNonEmptyString(safeVerifier.patch_coverage) || 'unknown'

  return `Verifier assessed patch=${patch_coverage}.`
}

function escapeHtmlCommentValue (value: unknown): string {
  return String(value ?? '')
    .replace(/-->/g, '--&gt;')
    .replace(/\r?\n/g, ' ')
    .trim()
}

function renderIssueAnalysisSection (analysis: unknown): string | null {
  const safeAnalysis = isRecord(analysis) ? analysis : {}
  if (!analysis) {
    return null
  }

  const lines = [
    `**Verdict:** ${inlineCode(safeAnalysis.verdict ?? 'unknown')}`,
    '',
    String(safeAnalysis.overview ?? 'Issue analysis completed.'),
    '',
    ...renderAnalysisNarratives(safeAnalysis.narratives)
  ]

  return lines.join('\n')
}

function renderIssueMitigationSection (mitigation: unknown): string | null {
  const safeMitigation = isRecord(mitigation) ? mitigation : {}
  if (!mitigation) {
    return null
  }

  const changed_files = asList<string>(safeMitigation.changed_files)

  const lines = [
    String(safeMitigation.overview ?? 'Issue mitigation completed.')
  ]

  if (changed_files.length > 0) {
    lines.push('', ...renderChangedFilesLines(changed_files))
  }

  return lines.join('\n')
}

function renderIssueVerificationSection (verification: unknown): string | null {
  const safeVerification = isRecord(verification) ? verification : {}
  if (!verification) {
    return null
  }

  const lines = renderVerificationSummaryLines(safeVerification, {
    includeHeadline: true,
    includeOverview: false,
    includeUnknownResolutionNextStep: true,
    reviewTargetClaimFallback: '(none)'
  })

  return lines.join('\n')
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

function renderIssueCodeModificationSummary (
  mitigation: unknown,
  draftPrPlan: DraftPrPlanLike | null,
  draftPullRequest: DraftPullRequestLike | null
): string | null {
  const safeMitigation = isRecord(mitigation) ? mitigation : {}
  if (!mitigation || !draftPrPlan) {
    return null
  }

  const changed_files = Array.isArray(draftPrPlan.changed_files)
    ? draftPrPlan.changed_files
    : []
  const lines = [
    '## Code Modification Summary',
    '',
    `**Patch Ready For Draft PR:** ${inlineCode(draftPrPlan.patch_ready ? 'yes' : 'no')}`
  ]

  if (!draftPrPlan.patch_ready) {
    lines.push(
      '',
      String(
        safeMitigation.overview ??
        'No concrete patch is ready yet, so the issue should stay as a summary thread until a code change is produced.'
      )
    )
    return lines.join('\n')
  }

  lines.push(
    '',
    `**Suggested Draft PR Title:** ${draftPrPlan.title}`,
    draftPullRequest?.html_url
      ? `**Draft PR:** ${draftPullRequest.html_url}`
      : '**Draft PR:** not created',
    '',
    '### Changed Files',
    '',
    ...(changed_files.length > 0
      ? renderChangedFilesLines(changed_files).slice(2)
      : ['- No changed files were recorded.'])
  )

  if (draftPrPlan.patch_preview) {
    lines.push('', '### Patch Preview', '', '```diff', draftPrPlan.patch_preview, '```')
  }

  lines.push(
    '',
    'Full analysis, patch rationale, and verification details should move to the draft PR body once the PR is opened.'
  )

  return lines.join('\n')
}

function renderSuggestedDraftPrSection (
  issue: IssueLike,
  draftPrPlan: DraftPrPlanLike | null,
  draftPullRequest: DraftPullRequestLike | null
): string | null {
  if (!draftPrPlan?.patch_ready || draftPullRequest?.html_url) {
    return null
  }

  const sections = draftPrPlan.sections ?? {}
  const summary = Array.isArray(sections.summary) ? sections.summary : []
  const code_changes = Array.isArray(sections.code_changes) ? sections.code_changes : []
  const verification = Array.isArray(sections.verification) ? sections.verification : []
  const residual_risks = Array.isArray(sections.residual_risks) ? sections.residual_risks : []

  const lines = [
    '## Suggested Draft PR',
    '',
    `**Title:** ${draftPrPlan.title}`,
    '',
    '### Body Structure',
    '',
    `- Links: Refs #${issue.issue_number}`,
    ...summary.map((item) => `- Summary: ${item}`),
    ...code_changes.map((item) => `- Code Change: ${item}`),
    ...verification.map((item) => `- Verification: ${item}`)
  ]

  if (residual_risks.length > 0) {
    lines.push(...residual_risks.map((item) => `- Residual Risk: ${item}`))
  }

  lines.push('', 'Keep the issue comment short; put the full remediation narrative and any larger diff context into the draft PR.')

  return lines.join('\n')
}

export function hasReviewRecordPatchReadyForPromotion (review_record: ReviewRecord | null | undefined): boolean {
  return asList(review_record?.mitigation?.file_changes).length > 0
}

export function normalizePromotionFilePath (filePath: unknown): string {
  const rawValue = String(filePath ?? '').trim()

  if (!rawValue) {
    return ''
  }

  const normalized = rawValue.replace(/\\/g, '/')

  if (normalized === '/workspace') {
    return ''
  }

  if (normalized.startsWith('/workspace/')) {
    return validateRepoRelativePath(normalized.slice('/workspace/'.length))
  }

  if (normalized.startsWith('workspace/')) {
    return validateRepoRelativePath(normalized.slice('workspace/'.length))
  }

  return validateRepoRelativePath(normalized)
}

function normalizeDisplayFilePath (filePath: unknown): string {
  try {
    return normalizePromotionFilePath(filePath)
  } catch {
    // Display-only changed_files can be noisy model output; publish paths stay strict.
    return ''
  }
}

function normalizeDisplayFiles (items: unknown): string[] {
  return Array.isArray(items)
    ? [...new Set(
        items
          .map((item) => normalizeDisplayFilePath(item))
          .filter((item): item is string => Boolean(item))
      )]
    : []
}

function buildPatchPreviewFromReviewRecord (review_record: ReviewRecord | null | undefined): string | null {
  const patch = asNonEmptyString(review_record?.mitigation?.patch_diff)
  if (!patch) {
    return null
  }

  const previewLines = patch
    .split('\n')
    .filter((line) => !line.startsWith('diff --git '))
    .slice(0, 32)

  return previewLines.join('\n').trim() || null
}

function renderFoldedBlock (summary: string, bodyLines: unknown): string[] {
  const lines = Array.isArray(bodyLines)
    ? bodyLines.filter((line) => line !== null && line !== undefined && line !== '')
    : []

  if (lines.length === 0) {
    return []
  }

  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    ...lines.map((line) => String(line)),
    '',
    '</details>'
  ]
}

export function buildDraftPullRequestTitleFromReviewRecord (issue: IssueLike): string {
  const shortTitle =
    asNonEmptyString(issue.issue_title) ||
    `Mitigate security issue #${issue.issue_number}`

  return `[sec] ${shortTitle}`
}

export function buildDraftPullRequestBodyFromReviewRecord ({
  issue,
  review_record
}: {
  issue: IssueLike
  review_record: ReviewRecord | null | undefined
}): string {
  const analysis = review_record?.analysis ?? EMPTY_ANALYSIS
  const mitigation = review_record?.mitigation ?? EMPTY_MITIGATION
  const verification = review_record?.verification ?? EMPTY_VERIFICATION
  const changed_files = normalizeDisplayFiles(mitigation.changed_files)
  const residual_risks = uniqueNonEmptyStrings(verification.residual_risks, 6)
  const visibleResidualRisks = residual_risks.slice(0, 3)
  const analysisLines = [
    `- Verdict: ${inlineCode(analysis.verdict ?? 'unknown')}`,
    '',
    String(analysis.overview ?? 'Issue analysis completed.'),
    '',
    ...renderAnalysisNarratives(analysis.narratives)
  ]
  const code_changesLines = [
    'Changed files:',
    '',
    ...(changed_files.length > 0
      ? renderChangedFilesLines(changed_files).slice(2)
      : ['- No changed files were recorded.']),
    '',
    'Exact code changes are available in the PR Files changed view.',
    'The PR body intentionally summarizes the patch instead of duplicating the full diff.'
  ]
  const verificationLines = [
    `- Patch coverage: ${inlineCode(verification.patch_coverage ?? 'unknown')}`,
    `- Regression status: ${inlineCode(verification.regression_status ?? 'unknown')}`,
    `- Resolution next step: ${inlineCode(verification.resolution_next_step ?? 'unknown')}`,
    `- Validation level: ${inlineCode(verification.validation_level ?? 'unknown')}`,
    `- Patch findings: ${inlineCode(asList(verification.patch_findings).length)}`,
    `- Verification findings: ${inlineCode(asList(verification.verification_findings).length)}`
  ]
  const reviewerNotesLines = [
    '- This PR is intentionally narrow.',
    '- It focuses on the concrete code change already produced by the mitigation stage.',
    '- Follow-up hardening, if needed, should be reviewed separately from this patch.'
  ]
  const lines = [
    `Refs #${issue.issue_number}`,
    '',
    `<!-- sec-review-bot:generated-from-issue-${issue.issue_number} -->`,
    `<!-- sec-review-bot-patch-coverage: ${verification.patch_coverage ?? 'unknown'} -->`,
    `<!-- sec-review-bot-regression-status: ${verification.regression_status ?? 'unknown'} -->`,
    `<!-- sec-review-bot-resolution-next-step: ${verification.resolution_next_step ?? 'unknown'} -->`,
    `<!-- sec-review-bot-validation-level: ${verification.validation_level ?? 'unknown'} -->`,
    `<!-- sec-review-bot-changed-file-count: ${changed_files.length} -->`,
    `<!-- sec-review-bot-residual-risk-count: ${residual_risks.length} -->`,
    ...residual_risks.map((item) => `<!-- sec-review-bot-residual-risk: ${escapeHtmlCommentValue(item)} -->`),
    '',
    '## Summary',
    '',
    `This draft PR applies a focused mitigation for security issue #${issue.issue_number}.`,
    '',
    `**Patch Coverage:** ${inlineCode(verification.patch_coverage ?? 'unknown')}`,
    `**Regression Status:** ${inlineCode(verification.regression_status ?? 'unknown')}`,
    `**Resolution Next Step:** ${inlineCode(verification.resolution_next_step ?? 'unknown')}`,
    `**Changed Files:** ${inlineCode(changed_files.length)}`,
    '',
    String(
      mitigation.overview ||
      analysis.overview ||
      `This change mitigates the security issue reported in #${issue.issue_number}.`
    ),
    ''
  ]

  lines.push(...renderFoldedBlock('Analysis', analysisLines), '')
  lines.push(...renderFoldedBlock('Code Changes', code_changesLines), '')
  lines.push(...renderFoldedBlock('Verification', verificationLines), '')

  if (visibleResidualRisks.length > 0) {
    const visibleRiskLines = visibleResidualRisks.map((item) => `- ${item}`)
    if (residual_risks.length > visibleResidualRisks.length) {
      visibleRiskLines.push(`- (+${residual_risks.length - visibleResidualRisks.length} more item(s) in PR metadata comments)`)
    }
    lines.push(...renderFoldedBlock('Residual Risks', visibleRiskLines), '')
  }

  lines.push(...renderFoldedBlock('Notes For Reviewers', reviewerNotesLines))

  return lines.join('\n')
}

export async function buildSuggestedDraftPrPlanFromReviewRecord ({
  issue,
  review_record
}: {
  issue: IssueLike
  review_record: ReviewRecord | null | undefined
}): Promise<DraftPrPlanLike> {
  const changed_files = normalizeDisplayFiles(review_record?.mitigation?.changed_files)
  const patch_ready = hasReviewRecordPatchReadyForPromotion(review_record)
  const patch_preview = patch_ready
    ? buildPatchPreviewFromReviewRecord(review_record)
    : null
  const verification = review_record?.verification ?? EMPTY_VERIFICATION
  const title = buildDraftPullRequestTitleFromReviewRecord(issue)

  return {
    recommended_action: patch_ready ? 'open-draft-pr' : 'keep-issue-summary-only',
    patch_ready,
    title,
    changed_files,
    patch_preview,
    sections: {
      summary: [
        `Mitigates issue #${issue.issue_number}.`,
        asNonEmptyString(review_record?.analysis?.overview),
        asNonEmptyString(review_record?.mitigation?.overview)
      ].filter((item): item is string => Boolean(item)),
      code_changes: changed_files.map((item) => `\`${item}\``),
      verification: [
        buildVerifierHeadline(verification),
        `Patch coverage: ${inlineCode(verification.patch_coverage ?? 'unknown')}`,
        `Regression status: ${inlineCode(verification.regression_status ?? 'unknown')}`,
        `Validation level: ${inlineCode(verification.validation_level ?? 'unknown')}`
      ].filter((item): item is string => Boolean(item)),
      residual_risks: asList<string>(verification.residual_risks).slice(0, 5)
    }
  }
}

export function renderIssueReviewCommentFromReviewRecord ({
  issue,
  review_record,
  draftPrPlan,
  draftPullRequest
}: {
  issue: IssueLike
  review_record: ReviewRecord | null | undefined
  draftPrPlan: DraftPrPlanLike | null
  draftPullRequest: DraftPullRequestLike | null
}): string {
  const analysis = review_record?.analysis ?? EMPTY_ANALYSIS
  const mitigation = review_record?.mitigation ?? EMPTY_MITIGATION
  const verification = review_record?.verification ?? EMPTY_VERIFICATION
  const analysisSection = renderIssueAnalysisSection(analysis)
  const mitigationSection = renderIssueMitigationSection(mitigation)
  const verificationSection = renderIssueVerificationSection(verification)
  const promotionComment = draftPullRequest?.html_url
    ? [
        '## Issue Security Review',
        '',
        `**Analyzer Verdict:** ${inlineCode(analysis.verdict ?? 'unknown')}`,
        `**Verification:** ${inlineCode(verification.patch_coverage ?? 'unknown')}`,
        `**Regression Status:** ${inlineCode(verification.regression_status ?? 'unknown')}`,
        '**Patch Ready:** `yes`',
        '',
        'A concrete mitigation patch was produced and promoted into a draft PR for full review.',
        '',
        `PR: #${draftPullRequest.number} (${draftPullRequest.html_url})`,
        '',
        'The issue comment stays short on purpose. The full analysis, patch summary, verification notes, and residual risks now live in the draft PR body.'
      ].join('\n')
    : null
  const securitySummary = [
    '## Security Review',
    '',
    `**Risk Verdict:** ${inlineCode(analysis.verdict ?? 'unknown')}`,
    `**Patch Coverage:** ${inlineCode(verification.patch_coverage ?? 'unknown')}`,
    `**Regression Status:** ${inlineCode(verification.regression_status ?? 'unknown')}`,
    `**Patch Ready:** ${inlineCode(draftPrPlan?.patch_ready ? 'yes' : 'no')}`,
    `**Next Step:** ${inlineCode(draftPrPlan?.recommended_action ?? 'issue-only')}`,
    '',
    String(
      verification.patch_coverage ? buildVerifierHeadline(verification) : (
        analysis.overview ?? `Security review completed for issue #${issue.issue_number}.`
      )
    )
  ].join('\n')

  return [
    promotionComment ?? securitySummary,
    draftPullRequest?.html_url
      ? null
      : renderIssueCodeModificationSummary(mitigation, draftPrPlan, draftPullRequest),
    draftPullRequest?.html_url
      ? null
      : renderFoldedSection('Suggested Draft PR', renderSuggestedDraftPrSection(issue, draftPrPlan, draftPullRequest)),
    draftPullRequest?.html_url
      ? null
      : renderFoldedSection('Analysis', analysisSection),
    draftPullRequest?.html_url
      ? null
      : renderFoldedSection('Mitigation', mitigationSection),
    draftPullRequest?.html_url
      ? null
      : renderFoldedSection('Verification', verificationSection)
  ].filter((item): item is string => Boolean(item)).join('\n\n')
}
