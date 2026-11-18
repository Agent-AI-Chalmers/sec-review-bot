// Append-only coordination event log. Every state transition on a coordination axis writes
// one row here, in the same transaction as the snapshot update, so an operator can see how a
// run reached its current state instead of reconstructing it from row mtimes or process logs.
//
// This is an audit trail, not event sourcing: the snapshot tables stay the current-state
// truth, and writes never depend on the log. It records only Review Runs coordination axes;
// the Execution's own execution history lives in Temporal and is deliberately not duplicated.
import type { PoolClient } from 'pg'

import type { ReviewRunEvent } from '../shapes.js'

export type CoordinationAxis = 'execution' | 'preparation' | 'publication'

export interface AppendEventFields {
  runId: string
  connectorId: string
  fromStatus: string | null
  toStatus: string
  reasonCode?: string | null
}

/** Only publication is made of steps, so only a publication event may name one; the union keeps
 * the other combinations unrepresentable, matching the table's CHECK. */
export type AppendEventArgs = AppendEventFields &
  (
    | { axis: Exclude<CoordinationAxis, 'publication'>; stepKey?: never }
    | { axis: 'publication'; stepKey?: string }
  )

export interface ReviewRunEventRow {
  event_id: string
  run_id: string
  connector_id: string
  axis: CoordinationAxis
  step_key: string | null
  from_status: string | null
  to_status: string
  reason_code: string | null
  occurred_at: Date
}

/** Append one transition. Callers run this on the same client as the snapshot UPDATE, so the
 * log and the state can never diverge: a rolled-back transition leaves no event. */
export async function appendEvent(client: PoolClient, args: AppendEventArgs): Promise<string> {
  const result = await client.query<{ event_id: string }>(
    `INSERT INTO review_run_events
       (run_id, connector_id, axis, step_key, from_status, to_status, reason_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING event_id`,
    [
      args.runId,
      args.connectorId,
      args.axis,
      args.stepKey ?? null,
      args.fromStatus,
      args.toStatus,
      args.reasonCode ?? null
    ]
  )
  const event = result.rows[0]
  if (event === undefined) throw new Error('Appending a coordination event returned no id.')
  return event.event_id
}

/** The observed, ordered event list for one run. Rows are returned oldest first, with
 * `event_id` breaking ties within the same microsecond timestamp. */
export async function listEvents(
  client: Pick<PoolClient, 'query'>,
  runId: string,
  connectorId: string
): Promise<ReviewRunEvent[]> {
  const result = await client.query<ReviewRunEventRow>(
    `SELECT event_id, run_id, connector_id, axis, step_key, from_status, to_status,
            reason_code, occurred_at
     FROM review_run_events
     WHERE run_id=$1 AND connector_id=$2
     ORDER BY occurred_at, event_id`,
    [runId, connectorId]
  )
  return result.rows.map((row) => ({
    event_id: Number(row.event_id),
    axis: row.axis,
    step_key: row.step_key,
    from_status: row.from_status,
    to_status: row.to_status,
    reason_code: row.reason_code,
    occurred_at: row.occurred_at.toISOString()
  }))
}
