import type { FileChange } from './file-change.js'
import { assertV5ReviewRecord } from '../infrastructure/runner/contract-schema.js'

type AnyRecord = Record<string, unknown>

type AnalysisVerdict = 'no-actionable-finding' | 'inconclusive' | 'plausible-risk' | 'confirmed-defect' | 'confirmed-vulnerability'
type ValidationLevel = 'static' | 'logic-simulated' | 'runtime-partial' | 'runtime-endpoint'
type PatchCoverage = 'full' | 'partial' | 'local-only' | 'unresolved' | 'misaligned' | 'no-patch' | 'not-applicable'
type RegressionStatus = 'passed' | 'failed' | 'not-run' | 'not-applicable' | 'unresolved'
type ResolutionNextStep = 'none' | 'retry-ai' | 'manual-review'
type CvssOutcome = 'scored' | 'not-scored' | 'skipped'

// Compile-time projection of review-record.schema.json; Ajv owns runtime validation.
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

export function parseReviewRecord (value: unknown): ReviewRecord {
  assertV5ReviewRecord(value)
  return value as ReviewRecord
}
