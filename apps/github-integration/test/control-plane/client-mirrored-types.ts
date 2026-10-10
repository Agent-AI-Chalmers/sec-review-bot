// The client's copies of the shapes that cross the store boundary.
//
// The integration does not import the Control Plane package, so it restates seven shapes
// locally. Nothing tied the two sets together, so a renamed or invented field would read
// `undefined` at runtime with every check still green.
//
// Only containment is asserted, and the direction depends on what each pair promises.
// `ReviewRunRecord` is deliberately narrower here — the integration never reads
// `runner_status`, `publication_status`, or the per-axis `updated_at` fields — and
// `PublicationWork` inherits that narrower view. The rest are meant to name the same keys
// and accept the same values, so they are compared both ways: a key-set comparison would
// not notice a widened union or a relaxed literal — which is how `kind: string` went
// unnoticed here — while a value comparison would not notice an optional field added on
// one side only. A field the client adds must exist on the Control Plane side in every
// case; that is the direction that breaks at runtime.
//
// Four calls also pass object shapes inline — the failure envelope, the retry option, and
// the remote object. Those have no name to compare, so their whole call signature is
// compared instead: the argument tuple and the return type, via `Parameters` and
// `ReturnType`. That covers argument order and count too, which a shape comparison misses.
//
// The control-plane package cannot import this file back, and this package has no generated
// view of the contract to alias, so its copies stay written here and are compared against the
// control-plane's own (contract-derived) types.
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
/** `A` and `B` name the same keys and accept the same values. */
type SameShape<A, B> = SameKeys<A, B> extends true ? SameValues<A, B> : false
type Expect<T extends true> = T

export type StatusUnionMatches = Expect<SameValues<ClientStatus, ControlPlaneStatus>>

/**
 * Both dimensions: `workflow` is a union, so value equality is needed, and
 * `runner_input`/`ingress_*` are optional, so key equality is needed too.
 */
export type CreateArgsMatchTheContract = Expect<
  SameShape<ClientCreateArgs, ControlPlaneCreateArgs>
>

export type ClientRecordIsWithinControlPlaneRecord = Expect<
  KeysWithin<ClientRecord, ControlPlaneRecord>
>

export type AdmissionKeysMatch = Expect<SameKeys<ClientAdmission, ControlPlaneAdmission>>

export type PublicationWorkKeysMatch = Expect<KeysWithin<ClientWork, ControlPlaneWork>>

/**
 * By value as well as by key set: `status` is a union, so value equality is needed on top
 * of the key comparison.
 */
export type PublicationStepMatchTheContract = Expect<SameShape<ClientStep, ControlPlaneStep>>

/**
 * Both dimensions: `kind` and `status` are literals, so value equality is needed — the
 * integration once declared `kind: string` while the contract fixes one value — and
 * `artifact`, `error_code`, and `message` are optional, so key equality is needed too.
 */
export type ArtifactStorageMatchesTheContract = Expect<
  SameShape<ClientArtifactStorage, ControlPlaneArtifactStorage>
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
