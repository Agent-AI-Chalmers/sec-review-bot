import type {
  ReviewRunWorkflow as WorkflowName,
  ExecutionArtifactStorage
} from './contracts.js'
import type { Pool, PoolClient } from 'pg'
import {
  normalizeArtifactStorage,
  type ExecutionStatus,
  type ObservedRun,
  type PublicationStatus,
  type ReviewRunRecord
} from './shapes.js'

type JsonObject = Record<string, unknown>

interface AxisRowColumns<S> {
  status: S
  started_at: string | null
  finished_at: string | null
  updated_at: string | null
  failure_code: string | null
  failure_message: string | null
}

/** The row `RUN_SELECT` produces: the run trunk, its three axes, and the notice outbox.
 *
 * `executions` and `preparations` are LEFT JOINed, so their axes carry a `missing` flag rather
 * than being nullable: a run with a missing axis row is corruption the projection must report,
 * and a null axis would force every caller to re-decide what a missing axis means. `publications`
 * is an inner join, so it has no such flag. */
export interface ReviewRunRow {
  trunk: {
    run_id: string
    workflow: WorkflowName
    source_platform: 'github'
    connector_id: string
    publish_context: JsonObject
    created_at: string
    created_at_cursor: string
    ingress_kind: 'github_webhook' | 'github_actions_dispatch' | null
    ingress_key: string | null
  }
  execution: AxisRowColumns<ExecutionStatus> & {
    missing: boolean
    input: JsonObject | null
    observed_at: string | null
    artifact_storage: ExecutionArtifactStorage | null
    workflow_result: unknown | null
  }
  publication: AxisRowColumns<PublicationStatus>
  preparation: AxisRowColumns<
    'pending' | 'preparing' | 'submitted' | 'failed' | null
  > & {
    missing: boolean
    attempt_count: number | null
    disconnect_reason: string | null
  }
  /** Written on any axis' terminal failure; `status` is null when no notice exists.
   *
   * Taken from the read contract rather than restated, so a state added to the notice machine
   * (or one renamed, as `skipped` became `failed`) cannot leave this row type behind. */
  notices: ObservedRun['notices']
}

/**
 * The full cross-axis read: one run trunk row joined to its three axis rows.
 *
 * `created_at_cursor` carries the full-precision (microsecond) UTC timestamp for keyset
 * pagination. node-pg maps `created_at` to a millisecond JS Date, so a cursor built from the
 * truncated value would skip every row in the same millisecond; this string keeps the
 * microseconds for an exact `(created_at, run_id) < boundary`.
 *
 * `executions`, `preparations`, and the failure notice are LEFT JOINed so a run that somehow
 * lacks one of those rows is surfaced and reported by the projection, not silently dropped from
 * every read. `publications` is an inner join because publication is never optional.
 */
export const RUN_SELECT = `
  SELECT
    json_build_object(
      'run_id', r.run_id,
      'workflow', r.workflow,
      'source_platform', r.source_platform,
      'connector_id', r.connector_id,
      'publish_context', p.input,
      'created_at', r.created_at,
      'created_at_cursor', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'ingress_kind', r.ingress_kind,
      'ingress_key', r.ingress_key
    ) AS trunk,
    json_build_object(
      'status', e.status,
      'started_at', e.started_at,
      'finished_at', e.finished_at,
      'updated_at', e.observed_at,
      'failure_code', e.failure_code,
      'failure_message', e.failure_message,
      'missing', (e.run_id IS NULL),
      'input', e.input,
      'observed_at', e.observed_at,
      'artifact_storage', e.artifact_storage,
      'workflow_result', e.workflow_result
    ) AS execution,
    json_build_object(
      'status', p.status,
      'started_at', p.started_at,
      'finished_at', p.finished_at,
      'updated_at', p.updated_at,
      'failure_code', p.failure_code,
      'failure_message', p.failure_message
    ) AS publication,
    json_build_object(
      'status', pr.status,
      'started_at', pr.started_at,
      'finished_at', pr.finished_at,
      'updated_at', pr.updated_at,
      'failure_code', pr.failure_code,
      'failure_message', pr.failure_message,
      'missing', (pr.run_id IS NULL),
      'attempt_count', pr.attempt_count,
      'disconnect_reason', pr.disconnect_reason
    ) AS preparation,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'notice_id', n.notice_id,
        'kind', n.kind,
        'axis', n.axis,
        'status', n.status,
        'reason_code', n.reason_code,
        'comment_url', n.comment_url
      ) ORDER BY n.created_at, n.notice_id)
      FROM run_notices n
      WHERE n.run_id=r.run_id AND n.connector_id=r.connector_id
    ), '[]'::jsonb) AS notices
  FROM review_runs r
  JOIN publications p ON p.run_id = r.run_id AND p.connector_id = r.connector_id
  LEFT JOIN executions e ON e.run_id = r.run_id AND e.connector_id = r.connector_id
  LEFT JOIN preparations pr
    ON pr.run_id = r.run_id AND pr.connector_id = r.connector_id
`

/** Normalize a timestamp the SELECT produced. `json_build_object` serializes timestamptz as an
 * ISO string, so this only ever narrows the precision (microseconds to milliseconds) - it never
 * receives a `Date`. Values come from `clock_timestamp()`, so parsing is exact. */
function iso(value: string): string {
  return new Date(value).toISOString()
}
/** `iso` for an axis timestamp that is meaningful only once the phase reaches it. */
function isoOrNull(value: string | null): string | null {
  return value === null ? null : iso(value)
}
export function rowToRecord(row: ReviewRunRow): ReviewRunRecord {
  const { trunk, execution, publication, preparation } = row
  if (execution.missing) {
    // A run without its execution row is corrupt, not a valid record. Throwing makes the
    // projection report it in `dropped` instead of silently omitting or misrepresenting it.
    throw new Error(`run ${trunk.run_id} has no executions row`)
  }
  if (preparation.missing) {
    // Same rule as the execution axis: admission writes the run, its preparation, and its
    // execution in one transaction and nothing deletes an axis alone, so a missing preparation
    // row is corruption. Returning `preparation: null` would report it as a legitimate record,
    // which is exactly what the contract says null does *not* mean.
    throw new Error(`run ${trunk.run_id} has no preparations row`)
  }
  // The guard above proves the row exists, but the axis columns are still typed nullable because
  // the query LEFT JOINs them. Narrowing with real checks (rather than `as`) keeps the type
  // honest if a future column is added to the summary without a matching NOT NULL in the schema.
  if (preparation.status === null || preparation.attempt_count === null) {
    throw new Error(`run ${trunk.run_id} has an incomplete preparations row`)
  }
  if (
    execution.observed_at === null ||
    preparation.updated_at === null ||
    publication.updated_at === null
  ) {
    // These three are NOT NULL in the schema, so a null here can only mean the LEFT JOIN was
    // somehow satisfied by a partial row. Checking rather than asserting keeps the type honest.
    throw new Error(`run ${trunk.run_id} has an incomplete axis row`)
  }
  // The run-level failure code names the axis that actually stopped the run, in the order the
  // phases run:
  // - a `failed` publication is the terminal failure: report its own code, even when that code
  //   is null. Falling back to the execution/preparation code here would attribute another
  //   axis' reason to the publication that genuinely failed.
  // - otherwise execution is next, then preparation. A skipped execution still reports the
  //   preparation failure that caused it, and a publication skipped because execution failed
  //   reports that execution reason, because publication itself never failed.
  const publicationFailure = publication.status === 'failed'
  return {
    run_id: trunk.run_id,
    workflow: trunk.workflow,
    source_platform: trunk.source_platform,
    connector_id: trunk.connector_id,
    publish_context: trunk.publish_context,
    ...(execution.input === null ? {} : { execution_input: execution.input }),
    preparation: {
      status: preparation.status,
      attempt_count: preparation.attempt_count,
      started_at: isoOrNull(preparation.started_at),
      finished_at: isoOrNull(preparation.finished_at),
      updated_at: iso(preparation.updated_at),
      failure_code: preparation.failure_code,
      // Non-null means coordination stopped retrying this run: the persisted story contradicts
      // an expiry conclusion, so it needs an operator decision. Exposed here so the condition is
      // visible on the read surface instead of only in a log line.
      disconnect_reason: preparation.disconnect_reason
    },
    // Each axis reports the same three instants under the same names: when it started, when it
    // finished, and (for execution) when it was last observed.
    execution: {
      status: execution.status,
      started_at: isoOrNull(execution.started_at),
      finished_at: isoOrNull(execution.finished_at),
      updated_at: iso(execution.observed_at)
    },
    publication: {
      status: publication.status,
      started_at: isoOrNull(publication.started_at),
      finished_at: isoOrNull(publication.finished_at),
      updated_at: iso(publication.updated_at)
    },
    created_at: iso(trunk.created_at),
    failure_code: publicationFailure
      ? publication.failure_code
      : (execution.failure_code ?? preparation.failure_code),
    failure_message: publicationFailure
      ? publication.failure_message
      : (execution.failure_message ?? preparation.failure_message),
    artifact_storage: normalizeArtifactStorage(
      execution.artifact_storage,
      `run ${trunk.run_id}`
    ),
    notices: row.notices,
    ...(trunk.ingress_kind ? { ingress_kind: trunk.ingress_kind } : {}),
    ...(trunk.ingress_key ? { ingress_key: trunk.ingress_key } : {})
  }
}

export async function findRunRecord(
  queryable: Pool | PoolClient,
  connectorId: string,
  runId: string
): Promise<ReviewRunRecord | null> {
  const result = await queryable.query<ReviewRunRow>(
    `${RUN_SELECT}
    WHERE r.run_id=$1 AND r.connector_id=$2`,
    [runId, connectorId]
  )
  const row = result.rows[0]
  return row === undefined ? null : rowToRecord(row)
}

/** One run the system stopped working on by itself, and the axis it is parked on.
 *
 * Distinct from `PreparationExpiryBlocked`, which is what one expiry pass could not conclude:
 * that type describes a failure inside coordination, while this one describes a run an operator
 * can act on, which may be parked on any of the three axes. */
