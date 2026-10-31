// Durable user-visible consequences of coordination events.
import crypto from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

import type { Database } from '../database/database.js'
import { transaction } from '../database/transaction.js'
import type { RunNoticeWork } from '../shapes.js'

type JsonObject = Record<string, unknown>

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

/** Owns notice delivery claims and outcomes across all review lifecycle axes. */
export class RunNoticeStore {
  constructor(
    private readonly database: Database,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  private get pool(): Pool {
    return this.database.pool()
  }

  /** Claim the oldest pending or expired delivery for this connector.
   * Every consumer of this queue must hold the provider credentials needed to deliver it. */
  async claimNext(): Promise<RunNoticeWork | null> {
    return await transaction(this.pool, async (client) => {
      const candidate = await client.query<{
        notice_id: string
        run_id: string
        input: JsonObject
        kind: 'failure' | 'attention'
        axis: 'preparation' | 'execution' | 'publication'
        reason_code: string | null
        status: 'pending' | 'delivering'
      }>(
        // Preparation owns the connector input for every axis. A missing row must not hide
        // a durable notice, so retain the notice and let the connector handle empty input.
        `SELECT n.notice_id,n.run_id,COALESCE(p.input,'{}'::jsonb) AS input,
                n.kind,n.axis,n.reason_code,n.status AS status
         FROM run_notices n
         LEFT JOIN preparations p
           ON p.run_id=n.run_id AND p.connector_id=n.connector_id
         WHERE n.connector_id=$1 AND (n.status='pending' OR
           (n.status='delivering' AND n.claimed_at <= clock_timestamp()-($2*interval '1 millisecond')))
         ORDER BY n.updated_at,n.run_id FOR UPDATE OF n SKIP LOCKED LIMIT 1`,
        [this.connectorId, this.claimTimeoutMs]
      )
      const work = candidate.rows[0]
      if (work === undefined) return null
      const token = crypto.randomUUID()
      // Recheck the claimable state under the row lock before issuing a fresh fencing token.
      const claimedNotice = await client.query<{
        status: 'pending' | 'delivering'
      }>(
        `UPDATE run_notices
         SET status='delivering', claim_token=$2,
             claimed_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE notice_id=$1 AND connector_id=$3 AND status=$4
           AND ($4 <> 'delivering' OR claimed_at <= clock_timestamp()-($5*interval '1 millisecond'))
         RETURNING status`,
        [
          work.notice_id,
          token,
          this.connectorId,
          work.status,
          this.claimTimeoutMs
        ]
      )
      if (claimedNotice.rowCount !== 1)
        throw new Error(`Run notice ${work.notice_id} could not be claimed.`)
      return { ...work, claim_token: token }
    })
  }

  async complete(
    noticeId: string,
    token: string,
    delivered: boolean,
    /** The comment the requester can read. Required for a delivery, rejected without one. */
    commentUrl?: string | null
  ): Promise<boolean> {
    if (delivered && (commentUrl === undefined || commentUrl === null)) {
      // A delivered notice with nowhere to point would claim the requester was told while giving
      // no way to verify it, so the caller's mistake is surfaced instead of stored.
      throw new Error(
        `Run notice ${noticeId} cannot be delivered without a comment_url.`
      )
    }
    if (!delivered && commentUrl !== undefined && commentUrl !== null) {
      // The other half of the same contract: an undelivered notice has no destination, so a URL
      // here means the caller believes something was posted. Discarding it silently would hide
      // that disagreement.
      throw new Error(
        `Run notice ${noticeId} cannot carry a comment_url when delivery failed.`
      )
    }
    return await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE run_notices SET status=$4, claim_token=NULL,
           claimed_at=NULL, comment_url=$5, updated_at=clock_timestamp()
         WHERE notice_id=$1 AND connector_id=$2 AND status='delivering' AND claim_token=$3`,
        // `failed`, not `skipped`: the connector attempted delivery and could not complete it.
        [
          noticeId,
          this.connectorId,
          token,
          delivered ? 'delivered' : 'failed',
          commentUrl ?? null
        ]
      )
      return result.rowCount === 1
    })
  }

  async renewClaim(noticeId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE run_notices
       SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE notice_id=$1 AND connector_id=$2 AND status='delivering' AND claim_token=$3`,
      [noticeId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  heartbeatIntervalMs(): number {
    return Math.max(1, Math.min(60_000, Math.floor(this.claimTimeoutMs / 3)))
  }
}
