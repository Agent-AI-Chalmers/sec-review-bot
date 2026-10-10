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
// The control-plane package cannot import this file back, so its own definitions are
// checked against the shared schemas instead.
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
  CreateReviewRunArgs as ClientCreateArgs,
  PublicationStepRecord as ClientStep,
  PublicationWork as ClientWork,
  ReviewRunAdmission as ClientAdmission,
  ReviewRunRecord as ClientRecord,
  ReviewRunStatus as ClientStatus
} from '../../src/control-plane/client.js'
import type { RunnerArtifactStorage as ClientArtifactStorage } from '../../src/runner/client.js'

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

export type ArtifactStorageKeysMatch = Expect<
  SameKeys<ClientArtifactStorage, ControlPlaneArtifactStorage>
>
