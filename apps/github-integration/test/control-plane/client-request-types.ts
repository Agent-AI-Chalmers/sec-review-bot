// The client's request bodies and success values come from the contract, not from a cast.
//
// `request()` used to take `body?: unknown` and a hand-written `<T>` for the response, so the
// object literals at each call site were unchecked: renaming a request field in `openapi.yaml`
// left the client compiling, and the failure only appeared as a field the service ignored.
// `request()` now takes the operationId and derives both sides from it.
//
// These assertions are type-level only; `client.test.ts` covers the transport behaviour.
import type { operations } from '../../src/control-plane/control-plane-api.js'
import type { ControlPlaneClient } from '../../src/control-plane/client.js'

type Expect<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** The submission body the contract declares exposes `preparation_token`, `publish_context`,
 * and `input` — the three fields the client sends. A rename in `openapi.yaml` breaks the
 * object literal in `submitPreparedRun` at compile time. */
export type SubmissionBodyFieldsMatchContract = Expect<
  Equals<
    keyof operations['submitPreparedRun']['requestBody']['content']['application/json'],
    'preparation_token' | 'publish_context' | 'input'
  >
>

/** The contract declares a request body for these operations, so the client cannot call them
 * without one: the body parameter is required by the derived type. */
export type PublicationStepsAcceptsStepKeys = Expect<
  Equals<Parameters<ControlPlaneClient['initializePublicationSteps']>, [string, string, string[]]>
>

/** `getRun` reads the internal record and may report absence, so its type keeps `null`. */
export type GetRunMayReportAbsence = Expect<
  Equals<
    Awaited<ReturnType<ControlPlaneClient['getRun']>>,
    operations['getInternalRun']['responses'][200]['content']['application/json'] | null
  >
>
