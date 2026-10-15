// The client's request bodies, success values, and URLs come from the contract, not from a
// cast or a hand-written string.
//
// `request()` used to take `body?: unknown`, a hand-written `<T>` for the response, and a
// free-standing `path` beside the `operationId` — so the operation could be paired with any
// other operation's URL and still compile. `request()` now takes only the operationId, and
// derives the path, method, request body, and success value from the generated contract
// projection (`operationRoutes`).
//
// These assertions are type-level only; `client.test.ts` covers the transport behaviour.
import { operationRoutes } from '../../src/control-plane/control-plane-api.js'
import type { operations } from '../../src/control-plane/control-plane-api.js'
import type { ControlPlaneClient } from '../../src/control-plane/client.js'

type Expect<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

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
  Equals<
    Parameters<ControlPlaneClient['initializePublicationSteps']>,
    [string, string, string[]]
  >
>

/** `getRun` reads the internal record and may report absence, so its type keeps `null`. */
export type GetRunMayReportAbsence = Expect<
  Equals<
    Awaited<ReturnType<ControlPlaneClient['getRun']>>,
    | operations['getInternalRun']['responses'][200]['content']['application/json']
    | null
  >
>

/** Every operation the contract declares has a route, so `request()` can look one up for any
 * `operationId` — the map and `operations` stay in step (both are projections of the same
 * document). A new operation without a route fails here. */
export type EveryOperationHasARoute = Expect<
  Equals<keyof typeof operationRoutes, keyof operations>
>

/** The route map carries the path and method as literal strings from the document, which is
 * what lets `request()` name only the operation: the URL is looked up, never passed in. A
 * value typed as `string` (a hand-written URL) would not satisfy this. */
export type RoutesAreLiteral = Expect<
  Equals<
    typeof operationRoutes.submitPreparedRun.path,
    '/v1/runs/{runId}/submission'
  >
>
export type RouteMethodsAreLiteral = Expect<
  Equals<typeof operationRoutes.admitRun.method, 'post'>
>
