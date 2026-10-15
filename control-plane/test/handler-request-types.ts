// Every route handler reads its request through the contract, not through a hand-written cast.
//
// `registerControlPlaneRoutes` used to read `request.body as { … }` in every handler. A cast
// asserts a shape rather than checking one, so the handler could name a field the contract
// does not declare and still compile: reading `body.step_keysX` typechecked, passed unit and
// integration tests, and answered HTTP 200 while passing the store `undefined` — the
// contract's `step_keys` silently became an empty step set. Nothing failed loudly.
//
// These assertions fail at compile time if a handler's view of its operation drifts from
// `openapi.yaml`. They are type-level only: the runtime behaviour they protect is covered by
// `server-http.test.ts`, which exercises the registered routes.
import type { operations } from '../src/contract-types-generated.js'
import type { PathParams, RequestBody } from '../src/route-types.js'

type Expect<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

/** The body an operation's handler reads is exactly the body the contract declares — so a
 * renamed, added, or removed field in `openapi.yaml` breaks the handler, not the caller. */
export type SubmissionBodyMatchesContract = Expect<
  Equals<
    RequestBody<'submitPreparedRun'>,
    operations['submitPreparedRun']['requestBody']['content']['application/json']
  >
>

export type PublicationStepsBodyMatchesContract = Expect<
  Equals<
    RequestBody<'initializePublicationSteps'>,
    operations['initializePublicationSteps']['requestBody']['content']['application/json']
  >
>

export type PathParamsMatchContract = Expect<
  Equals<
    PathParams<'completePublicationStep'>,
    { runId: string; stepKey: string }
  >
>

/** The handler reads `step_keys`, the name the contract declares. If the contract renames it,
 * this stops compiling — which is the regression that motivated `route-types.ts`. */
export type PublicationStepsBodyExposesContractFields = Expect<
  Equals<RequestBody<'initializePublicationSteps'>['step_keys'], string[]>
>
