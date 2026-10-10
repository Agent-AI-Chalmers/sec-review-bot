/**
 * The smallest boundary owned by Control Plane.
 *
 * Platform-specific request parsing and publication stay in `apps/`; agents
 * execute the run. Control Plane only admits a validated request, persists its
 * coordination identity, and coordinates execution by reference.
 */
import type { components, operations } from './runner-api-schema.js'

/**
 * The workflows this service accepts.
 *
 * Taken from the published contract rather than restated: the Runner derives its set from the
 * v5 schema map, so the OpenAPI enum is a projection of that single source. Restating the
 * names here is how this package and the Runner came to disagree about what exists.
 */
export type ControlPlaneWorkflow =
  operations['create_run_v1_workflows__workflow__runs_post']['parameters']['path']['workflow']

/**
 * The operations `POST /v1/store` accepts.
 *
 * The GitHub integration sends these by name over HTTP and Control Plane dispatches them
 * by name, so this list is the boundary's surface rather than an implementation detail:
 * the server refuses anything absent from it, and the client must send nothing else.
 * `apps/github-integration` asserts that its own sends stay inside this list, because the
 * two sides are separate packages whose operation lists can drift silently — which they
 * had: two methods kept sending names Control Plane had stopped accepting.
 */
export const controlPlaneOperations = [
  'submit_prepared_run',
  'admit_review_run',
  'getRun',
  'failPreparation',
  'renewPreparationClaim',
  'preparationHeartbeatIntervalMs',
  'claimNextPublication',
  'renewPublicationClaim',
  'initializePublicationSteps',
  'listPublicationSteps',
  'requirePublicationStepClaim',
  'completePublicationStep',
  'failPublicationStep',
  'completePublication',
  'failPublication'
] as const

export type ControlPlaneOperation = (typeof controlPlaneOperations)[number]

/**
 * Where a terminal run's diagnostics went.
 *
 * The runner owns this shape and publishes it in its OpenAPI document, which
 * `runner-api-schema.ts` projects here. This name is kept because the rest of the package
 * imports it, but the definition has one home rather than three.
 */
export type RunnerArtifactStorage = components['schemas']['RunnerArtifactStorage']
