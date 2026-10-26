/**
 * The smallest boundary owned by Control Plane.
 *
 * Platform-specific request parsing and publication stay in `apps/`; agents
 * execute the run. Control Plane only admits a validated request, persists its
 * coordination identity, and coordinates execution by reference.
 */
import type { components, operations } from './execution-api-schema.js'

/**
 * The workflows this service accepts.
 *
 * Taken from the published contract rather than restated: the Execution derives its set from the
 * v1 schema map, so the OpenAPI enum is a projection of that single source. Restating the
 * names here is how this package and the Execution came to disagree about what exists.
 */
export type ControlPlaneWorkflow =
  operations['createRun']['parameters']['path']['workflow']

/**
 * Where a terminal run's diagnostics went.
 *
 * The hand-maintained Execution API contract owns this shape;
 * `execution-api-schema.ts` is its generated local projection.
 */
export type ExecutionArtifactStorage =
  components['schemas']['ExecutionArtifactStorage']
