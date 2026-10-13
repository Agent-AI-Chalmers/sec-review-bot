// Single source for the Control Plane's public data shapes.
//
// Each shape is a TypeBox 1.x schema: `Type.Static<typeof Schema>` is the TypeScript type,
// the schema object itself is the JSON Schema (committed to
// contracts/control-plane-api/v1/), and the same schema feeds ajv for runtime validation.
// This replaces the previous hand-written type + hand-written JSON Schema pair, which
// drifted (see `artifact_storage`).
//
// TypeBox 1.x (the `typebox` package, unpinned from `@sinclair/typebox` 0.34) represents
// schemas as plain JSON Schema objects, so a shape referenced from another (e.g.
// `record: ReviewRunRecordSchema`) is *inlined* into the containing schema rather than
// emitted as a `$ref`. That inlining is what keeps `Type.Static` precise here: a `$ref`
// (`Type.Ref`) would otherwise resolve the field to `any`. Keep cross-shape references as
// direct schema values, not `Type.Ref`, precisely so the RPC contract stays drift-safe.
import Type from 'typebox'

import type { RunnerArtifactStorage } from './contracts.js'

export const WorkflowNameSchema = Type.Union([
  Type.Literal('issue-review'),
  Type.Literal('pull-request-review'),
  Type.Literal('repository-review')
])

export const IngressKindSchema = Type.Union([
  Type.Literal('github_webhook'),
  Type.Literal('github_actions_dispatch')
])

const RunnerStatusSchema = Type.Union([
  Type.Literal('preparing'),
  Type.Literal('recovering'),
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed')
])

const PublicationStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('publishing'),
  Type.Literal('published'),
  Type.Literal('failed'),
  Type.Literal('skipped')
])

const DateTime = Type.String({ format: 'date-time' })
export const JsonObject = Type.Record(Type.String(), Type.Unknown())

const ArtifactRef = Type.Object(
  {
    kind: Type.Literal('diagnostic_bundle'),
    uri: Type.String({
      pattern: '^s3://sec-review/runs/[^/]+/artifacts/diagnostic-tree\\.v1\\.tar\\.zst$'
    }),
    media_type: Type.Literal('application/tar+zstd'),
    digest: Type.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
    size_bytes: Type.Integer({ minimum: 0 })
  },
  { additionalProperties: false }
)

// The status discriminates the two non-null variants: an error carries error_code/message,
// while `available` carries the stored artifact. The loose RunnerArtifactStorage type that
// was projected from the runner's OpenAPI did not express this, so the type and the schema
// had drifted.
const ArtifactStorage = Type.Union([
  Type.Null(),
  Type.Object(
    {
      status: Type.Union([Type.Literal('unavailable'), Type.Literal('failed')]),
      error_code: Type.Optional(Type.String()),
      message: Type.Optional(Type.String())
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal('available'),
      artifact: ArtifactRef
    },
    { additionalProperties: false }
  )
])

/** Narrow the runner's loose artifact-storage type into the status-discriminated contract
 * shape. The runner's OpenAPI types `artifact` and `media_type` loosely, so this is where
 * the observer makes the discrimination explicit rather than passing the flat record
 * through. */
export function normalizeArtifactStorage(
  storage: RunnerArtifactStorage | null
): Type.Static<typeof ArtifactStorage> {
  if (storage === null) return null
  if (storage.status === 'available') {
    return {
      status: 'available',
      // The runner only reports `available` once an artifact is stored, and its
      // `media_type` is always the single value the observed contract pins down.
      artifact: storage.artifact as Type.Static<typeof ArtifactRef>
    }
  }
  return {
    status: storage.status,
    ...(storage.error_code == null ? {} : { error_code: storage.error_code }),
    ...(storage.message == null ? {} : { message: storage.message })
  }
}

export const PublicationStepRecordSchema = Type.Object(
  {
    step_key: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('running'),
      Type.Literal('succeeded'),
      Type.Literal('failed'),
      Type.Literal('terminal_failed')
    ]),
    failure_count: Type.Integer({ minimum: 0 }),
    remote_object_id: Type.Union([Type.String(), Type.Null()]),
    remote_object_url: Type.Union([Type.String({ format: 'uri' }), Type.Null()]),
    failure_code: Type.Union([Type.String(), Type.Null()]),
    failure_message: Type.Union([Type.String(), Type.Null()])
  },
  { additionalProperties: false }
)

// The observed summary is the store record minus the reconciliation id. TypeBox 1.x's
// `Omit` drops the source's `additionalProperties: false`, so rebuild the object to keep
// the closed shape (otherwise the summary would silently accept unknown fields).
export const PublicationStepSummarySchema = Type.Object(
  Type.Omit(PublicationStepRecordSchema, ['remote_object_id']).properties,
  { additionalProperties: false }
)

export const ObservedRunSchema = Type.Object(
  {
    run_id: Type.String({ minLength: 1 }),
    workflow: WorkflowNameSchema,
    execution_status: RunnerStatusSchema,
    publication_status: PublicationStatusSchema,
    created_at: DateTime,
    execution_updated_at: DateTime,
    publication_updated_at: DateTime,
    published_at: Type.Union([DateTime, Type.Null()]),
    failure_code: Type.Union([Type.String(), Type.Null()]),
    artifact_storage: ArtifactStorage,
    publication_steps: Type.Optional(Type.Array(PublicationStepSummarySchema))
  },
  { additionalProperties: false }
)

export const ReviewRunRecordSchema = Type.Object(
  {
    run_id: Type.String({ minLength: 1 }),
    workflow: WorkflowNameSchema,
    publish_context: JsonObject,
    runner_input: Type.Optional(JsonObject),
    ingress_kind: Type.Optional(IngressKindSchema),
    ingress_key: Type.Optional(Type.String()),
    runner_status: RunnerStatusSchema,
    publication_status: PublicationStatusSchema,
    created_at: DateTime,
    execution_updated_at: DateTime,
    publication_updated_at: DateTime,
    published_at: Type.Union([DateTime, Type.Null()]),
    failure_code: Type.Union([Type.String(), Type.Null()]),
    failure_message: Type.Union([Type.String(), Type.Null()]),
    artifact_storage: ArtifactStorage
  },
  { additionalProperties: false }
)

export const CreateReviewRunArgsSchema = Type.Pick(ReviewRunRecordSchema, [
  'run_id',
  'workflow',
  'publish_context',
  'runner_input',
  'ingress_kind',
  'ingress_key'
])

/** The admission result: the durable record plus whether this ingress created it, and the
 * preparation claim token (null when the run already existed in a terminal state). */
export const ReviewRunAdmissionSchema = Type.Object(
  {
    record: ReviewRunRecordSchema,
    created: Type.Boolean(),
    preparation_token: Type.Union([Type.String(), Type.Null()])
  },
  { additionalProperties: false }
)

/** A claimed publication unit: the run record plus the runner result blob and the claim
 * token that fences the publisher's side effects. */
export const PublicationWorkSchema = Type.Object(
  {
    ...ReviewRunRecordSchema.properties,
    workflow_result: Type.Unknown(),
    claim_token: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
)

export type WorkflowName = Type.Static<typeof WorkflowNameSchema>
export type RunnerStatus = Type.Static<typeof RunnerStatusSchema>
export type PublicationStatus = Type.Static<typeof PublicationStatusSchema>
export type ObservedRun = Type.Static<typeof ObservedRunSchema>
export type PublicationStepSummary = Type.Static<typeof PublicationStepSummarySchema>
export type PublicationStepRecord = Type.Static<typeof PublicationStepRecordSchema>
export type ReviewRunRecord = Type.Static<typeof ReviewRunRecordSchema>
export type CreateReviewRunArgs = Type.Static<typeof CreateReviewRunArgsSchema>
export type ReviewRunAdmission = Type.Static<typeof ReviewRunAdmissionSchema>
export type PublicationWork = Type.Static<typeof PublicationWorkSchema>
