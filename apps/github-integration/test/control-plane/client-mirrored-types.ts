// The client's copies of the shapes that cross the store boundary.
//
// The integration does not import the Control Plane package, so it restates seven shapes
// locally. Nothing tied the two sets together, so a renamed or invented field would read
// `undefined` at runtime with every check still green.
//
// Only containment is asserted, and the direction depends on what each pair promises.
// `ReviewRunRecord` is deliberately narrower here — the integration never reads
// `runner_status`, `publication_status`, or the per-axis `updated_at` fields — and
// `PublicationWork` inherits that narrower view. The rest are meant to name exactly the
// same keys. A field the client adds must exist on the Control Plane side in every case;
// that is the direction that breaks at runtime.
//
// Four calls also pass object shapes inline — the failure envelope, the retry option, and
// the remote object. Those have no name to compare, so their whole call signature is
// compared instead: the argument tuple and the return type, via `Parameters` and
// `ReturnType`. That covers argument order and count too, which a shape comparison misses.
//
// The control-plane package cannot import this file back, so its own definitions are
// checked against the shared schemas instead.
import type { ReviewRunStore } from '../../../../control-plane/src/index.js'

import type {
  CreateReviewRunArgs as ControlPlaneCreateArgs,
  ReviewRunAdmission as ControlPlaneAdmission,
  ReviewRunRecord as ControlPlaneRecord,
  PublicationStepRecord as ControlPlaneStep,
  PublicationWork as ControlPlaneWork,
  ReviewRunStatus as ControlPlaneStatus
} from '../../../../control-plane/src/index.js'

import type { RunnerArtifactStorage as ControlPlaneArtifactStorage } from '../../../../control-plane/src/index.js'

import type {
  ControlPlaneClient,
  CreateReviewRunArgs as ClientCreateArgs,
  PublicationStepRecord as ClientStep,
  PublicationWork as ClientWork,
  ReviewRunAdmission as ClientAdmission,
  ReviewRunRecord as ClientRecord,
  ReviewRunStatus as ClientStatus
} from '../../src/control-plane/client.js'
import type { RunnerArtifactStorage as ClientArtifactStorage } from '../../src/runner/shapes.js'

/** Every key of `A` is also a key of `B`. */
type KeysWithin<A, B> = [keyof A] extends [keyof B] ? true : false
/** `A` and `B` name exactly the same keys. */
type SameKeys<A, B> = KeysWithin<A, B> extends true ? KeysWithin<B, A> : false
/** `A` and `B` accept exactly the same values. Used for unions, which have no keys. */
type SameValues<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

export type StatusUnionMatches = Expect<SameValues<ClientStatus, ControlPlaneStatus>>

export type CreateArgsKeysMatch = Expect<SameKeys<ClientCreateArgs, ControlPlaneCreateArgs>>

export type ClientRecordIsWithinControlPlaneRecord = Expect<
  KeysWithin<ClientRecord, ControlPlaneRecord>
>

export type AdmissionKeysMatch = Expect<SameKeys<ClientAdmission, ControlPlaneAdmission>>

export type PublicationWorkKeysMatch = Expect<KeysWithin<ClientWork, ControlPlaneWork>>

export type PublicationStepKeysMatch = Expect<SameKeys<ClientStep, ControlPlaneStep>>

/**
 * Compared by value rather than by key set: this shape's fields are literals
 * (`kind` is a constant) and nullable, so a key comparison would miss a widened field.
 * It did: the integration declared `kind: string` while the contract fixes one value.
 */
export type ArtifactStorageMatchesTheContract = Expect<
  SameValues<ClientArtifactStorage, ControlPlaneArtifactStorage>
>

/** One whole call signature: its argument tuple and its return type. */
type SameCall<
  Client extends (...args: never[]) => unknown,
  Server extends (...args: never[]) => unknown
> =
  SameValues<Parameters<Client>, Parameters<Server>> extends true
    ? SameValues<ReturnType<Client>, ReturnType<Server>>
    : false

export type CompletePublicationStepCallMatches = Expect<
  SameCall<ControlPlaneClient['completePublicationStep'], ReviewRunStore['completePublicationStep']>
>

export type FailPublicationStepCallMatches = Expect<
  SameCall<ControlPlaneClient['failPublicationStep'], ReviewRunStore['failPublicationStep']>
>

export type FailPublicationCallMatches = Expect<
  SameCall<ControlPlaneClient['failPublication'], ReviewRunStore['failPublication']>
>

export type FailPreparationCallMatches = Expect<
  SameCall<ControlPlaneClient['failPreparation'], ReviewRunStore['failPreparation']>
>
