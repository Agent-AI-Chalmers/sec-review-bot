import type { ReviewRecord } from '../execution/integration-contract-types-generated.js'
import { assertReviewRecord } from '../execution/contract-schema.js'

export type { ReviewRecord }

export function parseReviewRecord(value: unknown): ReviewRecord {
  assertReviewRecord(value)
  return value as ReviewRecord
}
