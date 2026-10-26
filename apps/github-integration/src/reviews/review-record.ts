import type { ReviewRecord } from '../execution/execution-api-types-generated.js'
import { assertReviewRecord } from '../execution/execution-api-schema.js'

export type { ReviewRecord }

export function parseReviewRecord(value: unknown): ReviewRecord {
  assertReviewRecord(value)
  return value as ReviewRecord
}
