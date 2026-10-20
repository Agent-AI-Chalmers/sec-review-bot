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
