/**
 * The smallest boundary owned by Review Runs.
 *
 * Platform-specific request parsing and publication stay in `apps/`; agents
 * execute the run. Review Runs only admits a validated request, persists its
 * coordination identity, and coordinates execution by reference.
 */
import type { CreateRunOptions } from './execution-api-schema.js'

/**
 * The workflows this service accepts.
 *
 * Taken from the published contract rather than restated: the Execution derives its set from the
 * v1 schema map, so the OpenAPI enum is a projection of that single source. Restating the
 * names here is how this package and the Execution came to disagree about what exists.
 */
export type ReviewRunWorkflow = CreateRunOptions['path']['workflow']

/**
 * Where a terminal run's archive went.
 *
 * The hand-maintained Execution API contract owns this shape;
 * `execution-api-schema.ts` is its generated local projection.
 */
export type { ExecutionArtifactStorage } from './execution-api-schema.js'
