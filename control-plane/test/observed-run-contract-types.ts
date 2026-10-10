// The producer side of the observed-run contract.
//
// `observeRun()` is typed as `ObservedRun`, so comparing that type's keys against the
// checked-in schema is what keeps the response and the contract from drifting apart. The
// schema is read as a typed module for exactly this comparison.
//
// It compares key sets rather than values: a full value check needs a JSON Schema
// validator, which this package does not depend on. Key sets are the drift that has
// actually happened here — the schema once required a field the response no longer sent,
// while `additionalProperties: false` rejected the ones it did.
import schema from '../../contracts/control-plane-api/v1/observed-run.schema.json' with { type: 'json' }

import type { ObservedRun } from '../src/observability.js'

type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false
type Expect<T extends true> = T

export type ObservedRunKeysMatchTheContract = Expect<
  SameKeys<ObservedRun, (typeof schema)['properties']>
>
