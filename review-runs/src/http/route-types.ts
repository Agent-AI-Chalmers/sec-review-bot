// Bind each route handler to the request shape its own operation declares.
//
// `registerReviewRunsRoutes` used to read `request.body as { … }` and
// `request.params as { runId: string }` in every handler. A cast is not a check: the cast
// type was written by hand beside the contract, so it could name a field the contract does
// not declare, and nothing failed. A handler that read `body.step_keysX` typechecked,
// passed every test, and returned HTTP 200 while handing the store `undefined` — the
// contract's `step_keys` silently became an empty step set.
//
// These helpers replace the casts with a projection of the contract, so the handler's view
// of a request is the operation's own type from
// `contracts/review-runs-api/v1/openapi.yaml`. Renaming a field in the contract now breaks
// the handler that reads it at compile time instead of at run time.
import type { OperationOptionsById } from '../contract-types-generated.js'

type OperationId = keyof OperationOptionsById
type Operation<Id extends OperationId> = OperationOptionsById[Id]

/** The JSON request body the contract declares for an operation. */
export type RequestBody<Id extends OperationId> =
  Operation<Id> extends { body: infer Body } ? Body : never

/** The path parameters the contract declares for an operation. */
export type PathParams<Id extends OperationId> =
  Operation<Id> extends { path: infer Params } ? Params : never
