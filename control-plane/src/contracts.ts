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
 * v6 schema map, so the OpenAPI enum is a projection of that single source. Restating the
 * names here is how this package and the Runner came to disagree about what exists.
 */
export type ControlPlaneWorkflow =
  operations['create_run_v1_workflows__workflow__runs_post']['parameters']['path']['workflow']

/**
 * Where a terminal run's diagnostics went.
 *
 * The runner owns this shape and publishes it in its OpenAPI document, which
 * `runner-api-schema.ts` projects here. This name is kept because the rest of the package
 * imports it, but the definition has one home rather than three.
 */
export type RunnerArtifactStorage = components['schemas']['RunnerArtifactStorage']
