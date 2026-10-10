// The consumer side of the observed-run contract.
//
// The fixture and schema under `contracts/` are the same executable example the Control
// Plane validates its response against. This file ties the console's hand-written `Run`
// type to them, so a change to the contract cannot leave the console behind silently.
//
// Every check compares key sets rather than values, and the direction matters:
//
// - TypeScript widens JSON strings to `string`, so assigning a fixture to `Run` would
//   reject a perfectly correct example that carries `"execution_status": "succeeded"`
//   instead of the narrower union.
// - An optional field appears in the schema's properties but not in every example, so
//   equality is the wrong relation between an example and the schema. Each check below
//   asserts only the containment that its pairing actually promises.
import fixture from '../../../contracts/control-plane-api/v1/fixtures/observed-run.json' with { type: 'json' }
import schema from '../../../contracts/control-plane-api/v1/observed-run.schema.json' with { type: 'json' }

import type { ArtifactStorage, Run } from '../src/api.js'

/** Every key of `A` is also a key of `B`. */
type KeysWithin<A, B> = [keyof A] extends [keyof B] ? true : false
/** `A` and `B` name exactly the same keys. */
type SameKeys<A, B> = KeysWithin<A, B> extends true ? KeysWithin<B, A> : false
type Expect<T extends true> = T

/**
 * The example must be one the schema accepts: every field it carries has to be a field the
 * contract knows about. This is what keeps the example from teaching the console a shape
 * the Control Plane would never send.
 */
export type FixtureIsAcceptableToTheSchema = Expect<
  KeysWithin<typeof fixture, (typeof schema)['properties']>
>

/**
 * The console must model every field the example carries, except the ones it deliberately
 * does not: `publication_steps` travels on its own read path, so `Run` leaves it out. A
 * field that disappears from the example while the console still reads it turns this red.
 */
export type RunModelsTheExample = Expect<KeysWithin<Run, Omit<typeof fixture, 'publication_steps'>>>

/**
 * The artifact is required to be complete, so this pairing is the strict one: the console's
 * artifact type and the example's artifact must name the same fields. This is the check
 * that caught `uri` missing from the console's type while the contract required it.
 */
export type ArtifactKeysMatchTheContract = Expect<
  SameKeys<
    NonNullable<(typeof fixture)['artifact_storage']>['artifact'],
    NonNullable<ArtifactStorage['artifact']>
  >
>
