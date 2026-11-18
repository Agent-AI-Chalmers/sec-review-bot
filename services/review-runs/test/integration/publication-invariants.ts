import { expect } from 'vitest'
// The publication axis stores a copy of its strongest step state, re-derived by every step write.
// A write path that forgot the re-derivation would leave the copy stale while every edge it
// recorded still looked legal, so integration tests compare the stored axis with its steps after
// each test instead of trusting each path to remember.
import type { Pool } from 'pg'

/** Assert that every live publication of these connectors equals the strongest state of its
 * steps: `disconnected`, then `uncertain`, otherwise `publishing`. Concluded and unclaimed axes
 * are the owner's or the selector's decision and are not derived. */
export async function assertPublicationAxesFollowSteps(
  pool: Pool,
  connectorIds: readonly string[]
): Promise<void> {
  if (connectorIds.length === 0) {
    return
  }
  const drift = await pool.query<{
    run_id: string
    stored: string
    derived: string
  }>(
    `SELECT p.run_id, p.status AS stored,
            CASE
              WHEN bool_or(s.status='disconnected') THEN 'disconnected'
              WHEN bool_or(s.status='uncertain') THEN 'uncertain'
              ELSE 'publishing'
            END AS derived
     FROM publications p
     LEFT JOIN publication_steps s
       ON s.run_id=p.run_id AND s.connector_id=p.connector_id
     WHERE p.connector_id = ANY($1::text[])
       AND p.status IN ('publishing','uncertain','disconnected')
     GROUP BY p.run_id, p.status`,
    [connectorIds]
  )
  expect(
    drift.rows.filter((row) => row.stored !== row.derived),
    'a live publication axis must equal the strongest state of its steps'
  ).toStrictEqual([])
}
