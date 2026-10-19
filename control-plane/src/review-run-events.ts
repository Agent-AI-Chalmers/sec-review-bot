// Append-only coordination event log. Every state transition on a coordination axis writes
// one row here, in the same transaction as the snapshot update, so an operator can see how a
// run reached its current state instead of reconstructing it from row mtimes or process logs.
//
// This is an audit trail, not event sourcing: the snapshot tables stay the current-state
// truth, and writes never depend on the log. It records only Control Plane coordination axes;
// the Runner's own execution history lives in Temporal and is deliberately not duplicated.
import type { PoolClient } from 'pg'

import type { ReviewRunEvent } from './shapes.js'

export type CoordinationAxis =
  'runner' | 'preparation' | 'publication' | 'notice'

export interface AppendEventArgs {
  runId: string
  connectorId: string
  axis: CoordinationAxis
  fromStatus: string | null
  toStatus: string
  reasonCode?: string | null
}

export interface ReviewRunEventRow {
  event_id: string
  run_id: string
  connector_id: string
  axis: CoordinationAxis
  from_status: string | null
  to_status: string
  reason_code: string | null
  occurred_at: Date | string
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

/** Append one transition. Callers run this on the same client as the snapshot UPDATE, so the
 * log and the state can never diverge: a rolled-back transition leaves no event. */
export async function appendEvent(
  client: PoolClient,
  args: AppendEventArgs
): Promise<void> {
  await client.query(
    `INSERT INTO review_run_events
       (run_id, connector_id, axis, from_status, to_status, reason_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      args.runId,
      args.connectorId,
      args.axis,
      args.fromStatus,
      args.toStatus,
      args.reasonCode ?? null
    ]
  )
}

/** The observed, ordered event list for one run. Rows are returned oldest first, with
 * `event_id` breaking ties within the same microsecond timestamp. */
export async function listEvents(
  client: Pick<PoolClient, 'query'>,
  runId: string,
  connectorId: string
): Promise<ReviewRunEvent[]> {
  const result = await client.query<ReviewRunEventRow>(
    `SELECT event_id, run_id, connector_id, axis, from_status, to_status,
            reason_code, occurred_at
     FROM review_run_events
     WHERE run_id=$1 AND connector_id=$2
     ORDER BY occurred_at, event_id`,
    [runId, connectorId]
  )
  return result.rows.map((row) => ({
    event_id: Number(row.event_id),
    axis: row.axis,
    from_status: row.from_status,
    to_status: row.to_status,
    reason_code: row.reason_code,
    occurred_at: iso(row.occurred_at)
  }))
}
