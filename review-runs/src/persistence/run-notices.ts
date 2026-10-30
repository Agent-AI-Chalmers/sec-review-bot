// Durable user-visible consequences of coordination events.
import type { PoolClient } from 'pg'

export async function queueRunNotice(
  client: PoolClient,
  args: {
    runId: string
    connectorId: string
    sourceEventId: string
    kind: 'failure' | 'attention'
    axis: 'preparation' | 'execution' | 'publication'
    reasonCode: string | null
  }
): Promise<void> {
  await client.query(
    `INSERT INTO run_notices
       (run_id, connector_id, source_event_id, kind, axis, reason_code, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (source_event_id) DO NOTHING`,
    [
      args.runId,
      args.connectorId,
      args.sourceEventId,
      args.kind,
      args.axis,
      args.reasonCode
    ]
  )
}

/** Make an undelivered attention notice historical when its disconnected axis is resumed.
 *
 * This must run in the same transaction as the resume. In particular, changing a currently
 * `delivering` row clears its token immediately, so an old connector owner cannot renew or
 * complete a notice whose statement ("operator intervention is required") is no longer true.
 * Failure notices are intentionally excluded: they report terminal outcomes, not live attention
 * requirements, and no resume transition can make those outcomes disappear. */
export async function supersedeRunAttentionNotices(
  client: PoolClient,
  args: {
    runId: string
    connectorId: string
    axis: 'preparation' | 'execution' | 'publication'
  }
): Promise<void> {
  await client.query(
    `UPDATE run_notices
     SET status='superseded', claim_token=NULL, claimed_at=NULL,
         updated_at=clock_timestamp()
     WHERE run_id=$1 AND connector_id=$2 AND axis=$3 AND kind='attention'
       AND status IN ('pending','delivering')`,
    [args.runId, args.connectorId, args.axis]
  )
}
