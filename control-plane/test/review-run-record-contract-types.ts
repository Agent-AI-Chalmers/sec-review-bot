// The producer side of the review-run-record contract.
//
// Control Plane builds this object in `rowToRecord` and the integration declares its own
// view of it, so the schema, this type, and that view are three descriptions of one shape.
// This compares the type's keys against the schema's; the integration compares its narrower
// view against this type.
//
// A value-level check like the observed-run one is not possible here: a real record comes
// from a database row, and the suite that has a database is separate.
import schema from '../../contracts/control-plane-api/v1/review-run-record.schema.json' with { type: 'json' }

import type { ReviewRunRecord } from '../src/review-store.js'

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false
type Expect<T extends true> = T

export type ReviewRunRecordKeysMatchTheContract = Expect<
  SameKeys<ReviewRunRecord, (typeof schema)['properties']>
>
