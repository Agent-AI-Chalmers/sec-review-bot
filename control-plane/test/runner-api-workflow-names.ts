// Guard the contract's own claim about workflow names.
//
// `ControlPlaneWorkflow` is an alias into the generated schema, so this file does not restate
// the names. What it guards is the other direction: the route must keep publishing an enum.
// If it stopped, the alias would widen to `string` and nothing else would fail — the service
// would accept any workflow name at compile time while the Runner still rejected the rest.
import type { operations } from '../src/runner-api-schema.js'

type SpecWorkflow =
  operations['create_run_v1_workflows__workflow__runs_post']['parameters']['path']['workflow']

/** True only while the contract names the workflows instead of accepting any string. */
type NarrowerThanString<T> = [string] extends [T] ? false : true
type Expect<T extends true> = T

export type ContractPublishesWorkflowNames = Expect<NarrowerThanString<SpecWorkflow>>
