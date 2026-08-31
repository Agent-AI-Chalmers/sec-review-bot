import type { FileChange, FileMode, TextEncoding } from './file-change.js'
import { validateRepoRelativePathShape } from './repo-path.js'

type AnyRecord = Record<string, unknown>

const ANALYSIS_VERDICTS = [
  'no-actionable-finding',
  'inconclusive',
  'plausible-risk',
  'confirmed-defect',
  'confirmed-vulnerability'
] as const
const VALIDATION_LEVELS = ['static', 'logic-simulated', 'runtime-partial', 'runtime-endpoint'] as const
const PATCH_COVERAGES = ['full', 'partial', 'local-only', 'unresolved', 'misaligned', 'no-patch', 'not-applicable'] as const
const REGRESSION_STATUSES = ['passed', 'failed', 'not-run', 'not-applicable', 'unresolved'] as const
const RESOLUTION_NEXT_STEPS = ['none', 'retry-ai', 'manual-review'] as const
const CVSS_OUTCOMES = ['scored', 'not-scored', 'skipped'] as const

type AnalysisVerdict = typeof ANALYSIS_VERDICTS[number]
type ValidationLevel = typeof VALIDATION_LEVELS[number]
type PatchCoverage = typeof PATCH_COVERAGES[number]
type RegressionStatus = typeof REGRESSION_STATUSES[number]
type ResolutionNextStep = typeof RESOLUTION_NEXT_STEPS[number]
type CvssOutcome = typeof CVSS_OUTCOMES[number]

export interface ReviewRecord {
  analysis: {
    verdict: AnalysisVerdict | null
    overview: string | null
    narratives: AnyRecord[]
  }
  mitigation: {
    overview: string | null
    changed_files: string[]
    file_changes: FileChange[]
    patch_diff: string | null
  }
  verification: {
    overview: string | null
    review_target_claim: string | null
    validation_level: ValidationLevel | null
    patch_coverage: PatchCoverage | null
    regression_status: RegressionStatus | null
    resolution_next_step: ResolutionNextStep | null
    patch_findings: string[]
    verification_findings: string[]
    residual_risks: string[]
  }
  cvss: {
    outcome: CvssOutcome | null
    base_score: number | null
    severity: string | null
    vector: string | null
    overview: string | null
    not_scored_reason: string | null
  } | null
}

function isRecord (value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasField (value: AnyRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}

function requireRecord (value: unknown, label: string): AnyRecord {
  if (!isRecord(value)) {
    throw new Error(`malformed v4 review_record: ${label} must be an object.`)
  }
  return value
}

function requireField (record: AnyRecord, field: string, label: string): unknown {
  if (!hasField(record, field)) {
    throw new Error(`malformed v4 review_record: ${label}.${field} is required.`)
  }
  return record[field]
}

function textOrNull (value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value
    : null
}

function requiredNullableText (value: unknown, label: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`malformed v4 review_record: ${label} must be a string or null.`)
  }
  return textOrNull(value)
}

function requiredNullableEnum<const T extends string> (
  value: unknown,
  label: string,
  allowed: readonly T[]
): T | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`malformed v4 review_record: ${label} must be a string or null.`)
  }
  const normalized = value.trim()
  if (normalized === '') {
    return null
  }
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new Error(`malformed v4 review_record: ${label} has unknown value ${JSON.stringify(normalized)}.`)
  }
  return normalized as T
}

function requiredStringList (value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`malformed v4 review_record: ${label} must be an array.`)
  }

  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
}

function requiredRecordList (value: unknown, label: string): AnyRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`malformed v4 review_record: ${label} must be an array.`)
  }

  const records = value.filter(isRecord)
  if (records.length !== value.length) {
    throw new Error(`malformed v4 review_record: ${label} must contain only objects.`)
  }
  return records
}

function requireOnlyFields (record: AnyRecord, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed)
  const extraFields = Object.keys(record).filter((field) => !allowedFields.has(field))
  if (extraFields.length > 0) {
    throw new Error(
      `malformed v4 review_record: ${label} has unsupported field ${JSON.stringify(extraFields[0])}.`
    )
  }
}

function requiredNonEmptyString (value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`malformed v4 review_record: ${label} must be a non-empty string.`)
  }
  return value
}

function requiredCanonicalString (value: unknown, label: string): string {
  const text = requiredNonEmptyString(value, label)
  // Contract values must already be canonical; do not trim model output into a different schema shape.
  if (text !== text.trim()) {
    throw new Error(`malformed v4 review_record: ${label} must not include leading or trailing whitespace.`)
  }
  return text
}

function parseFileChange (value: unknown, label: string): FileChange {
  const change = requireRecord(value, label)
  const path = validateRepoRelativePathShape(requiredCanonicalString(requireField(change, 'path', label), `${label}.path`))
  const status = requireField(change, 'status', label)

  if (status === 'deleted') {
    requireOnlyFields(change, ['path', 'status'], label)
    return {
      path,
      status: 'deleted'
    }
  }

  if (status !== 'upsert') {
    throw new Error(`malformed v4 review_record: ${label}.status has unknown value ${JSON.stringify(status)}.`)
  }

  requireOnlyFields(change, ['path', 'status', 'content', 'content_encoding', 'mode'], label)

  const content = requireField(change, 'content', label)
  if (typeof content !== 'string') {
    throw new Error(`malformed v4 review_record: ${label}.content must be a string.`)
  }

  const contentEncoding = requireField(change, 'content_encoding', label)
  if (contentEncoding !== 'utf-8' && contentEncoding !== 'base64') {
    throw new Error(
      `malformed v4 review_record: ${label}.content_encoding has unknown value ${JSON.stringify(contentEncoding)}.`
    )
  }

  const mode = change.mode
  if (mode !== undefined && mode !== '100644' && mode !== '100755') {
    throw new Error(`malformed v4 review_record: ${label}.mode has unknown value ${JSON.stringify(mode)}.`)
  }

  return {
    path,
    status: 'upsert',
    content,
    content_encoding: contentEncoding as TextEncoding,
    ...(mode ? { mode: mode as FileMode } : {})
  }
}

function requiredFileChangeList (value: unknown, label: string): FileChange[] {
  if (!Array.isArray(value)) {
    throw new Error(`malformed v4 review_record: ${label} must be an array.`)
  }

  return value.map((item, index) => parseFileChange(item, `${label}[${index}]`))
}

function parseAnalysis (value: unknown): ReviewRecord['analysis'] {
  const analysis = requireRecord(value, 'analysis')
  requireOnlyFields(analysis, ['verdict', 'overview', 'narratives'], 'analysis')
  return {
    verdict: requiredNullableEnum(requireField(analysis, 'verdict', 'analysis'), 'analysis.verdict', ANALYSIS_VERDICTS),
    overview: requiredNullableText(requireField(analysis, 'overview', 'analysis'), 'analysis.overview'),
    narratives: requiredRecordList(requireField(analysis, 'narratives', 'analysis'), 'analysis.narratives')
  }
}

function parseMitigation (value: unknown): ReviewRecord['mitigation'] {
  const mitigation = requireRecord(value, 'mitigation')
  requireOnlyFields(mitigation, ['overview', 'changed_files', 'file_changes', 'patch_diff'], 'mitigation')
  return {
    overview: requiredNullableText(requireField(mitigation, 'overview', 'mitigation'), 'mitigation.overview'),
    changed_files: requiredStringList(requireField(mitigation, 'changed_files', 'mitigation'), 'mitigation.changed_files'),
    file_changes: requiredFileChangeList(requireField(mitigation, 'file_changes', 'mitigation'), 'mitigation.file_changes'),
    patch_diff: requiredNullableText(requireField(mitigation, 'patch_diff', 'mitigation'), 'mitigation.patch_diff')
  }
}

function parseVerification (value: unknown): ReviewRecord['verification'] {
  const verification = requireRecord(value, 'verification')
  requireOnlyFields(
    verification,
    [
      'overview',
      'review_target_claim',
      'validation_level',
      'patch_coverage',
      'regression_status',
      'resolution_next_step',
      'patch_findings',
      'verification_findings',
      'residual_risks'
    ],
    'verification'
  )
  return {
    overview: requiredNullableText(requireField(verification, 'overview', 'verification'), 'verification.overview'),
    review_target_claim: requiredNullableText(requireField(verification, 'review_target_claim', 'verification'), 'verification.review_target_claim'),
    validation_level: requiredNullableEnum(requireField(verification, 'validation_level', 'verification'), 'verification.validation_level', VALIDATION_LEVELS),
    patch_coverage: requiredNullableEnum(requireField(verification, 'patch_coverage', 'verification'), 'verification.patch_coverage', PATCH_COVERAGES),
    regression_status: requiredNullableEnum(requireField(verification, 'regression_status', 'verification'), 'verification.regression_status', REGRESSION_STATUSES),
    resolution_next_step: requiredNullableEnum(requireField(verification, 'resolution_next_step', 'verification'), 'verification.resolution_next_step', RESOLUTION_NEXT_STEPS),
    patch_findings: requiredStringList(requireField(verification, 'patch_findings', 'verification'), 'verification.patch_findings'),
    verification_findings: requiredStringList(requireField(verification, 'verification_findings', 'verification'), 'verification.verification_findings'),
    residual_risks: requiredStringList(requireField(verification, 'residual_risks', 'verification'), 'verification.residual_risks')
  }
}

function parseCvss (value: unknown): ReviewRecord['cvss'] {
  if (value === null) {
    return null
  }
  const cvss = requireRecord(value, 'cvss')
  requireOnlyFields(cvss, ['outcome', 'base_score', 'severity', 'vector', 'overview', 'not_scored_reason'], 'cvss')

  const baseScore = requireField(cvss, 'base_score', 'cvss')
  if (baseScore !== null && (typeof baseScore !== 'number' || baseScore < 0 || baseScore > 10)) {
    throw new Error('cvss.base_score must be a number from 0 to 10 or null.')
  }

  const severity = requireField(cvss, 'severity', 'cvss')
  if (severity !== null && typeof severity !== 'string') {
    throw new Error('cvss.severity must be a string or null.')
  }

  const vector = requireField(cvss, 'vector', 'cvss')
  if (vector !== null && typeof vector !== 'string') {
    throw new Error('cvss.vector must be a string or null.')
  }

  return {
    outcome: requiredNullableEnum(requireField(cvss, 'outcome', 'cvss'), 'cvss.outcome', CVSS_OUTCOMES),
    base_score: baseScore,
    severity,
    vector,
    overview: requiredNullableText(requireField(cvss, 'overview', 'cvss'), 'cvss.overview'),
    not_scored_reason: requiredNullableText(requireField(cvss, 'not_scored_reason', 'cvss'), 'cvss.not_scored_reason')
  }
}

export function parseReviewRecord (value: unknown): ReviewRecord {
  const record = requireRecord(value, 'review_record')
  requireOnlyFields(record, ['analysis', 'mitigation', 'verification', 'cvss'], 'review_record')

  return {
    analysis: parseAnalysis(requireField(record, 'analysis', 'review_record')),
    mitigation: parseMitigation(requireField(record, 'mitigation', 'review_record')),
    verification: parseVerification(requireField(record, 'verification', 'review_record')),
    cvss: parseCvss(requireField(record, 'cvss', 'review_record'))
  }
}
