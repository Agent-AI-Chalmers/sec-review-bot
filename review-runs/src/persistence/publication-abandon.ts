// One cross-axis transition shared by the stores: conclude a publication that can never publish.
//
// It lives in its own module because it is neither a preparation nor an execution concern, yet
// both of those axes trigger it when they prove the Execution will produce no result. Putting it in
// `publication-store.ts` would make `preparation-store.ts` import the publication store, breaking
// the rule that single-axis stores do not depend on each other. The composition root constructs
// those stores, while this small transaction helper lets each cross-axis caller share the state
// change without importing a sibling store.
import type { PoolClient } from 'pg'

import type { PublicationStatus } from '../shapes.js'

/** Converge a publication that has not concluded yet to `skipped`, in the caller's transaction.
 *
 * Three paths reach this: a preparation failure that proves the Execution was never called, an
 * execution failure found while polling, and a rejected submission replay. Each owns a different
 * trigger and writes its own audit event, but the state change itself is identical, so it lives
 * here rather than as a copy in each store. Taking the `client` keeps it in the caller's
 * transaction: the publication snapshot and that caller's other axis writes stay atomic.
 *
 * `publishing` is converged as well as `pending`. The normal path cannot leave a publication in
 * flight while execution is conclusively failed, but a replay or a forced repair can; with no
 * writer left, `complete` and `fail` both require the claim token, so the row would strand
 * forever. Clearing the token is what fences the old publisher out.
 *
 * Returns the status the row had before being skipped, or null when it was already concluded (in
 * which case nothing changes and the caller records no publication event). */
export async function abandonInFlightPublication(
  client: Pick<PoolClient, 'query'>,
  connectorId: string,
  runId: string
): Promise<PublicationStatus | null> {
  const result = await client.query<{ from_status: PublicationStatus }>(
    `WITH previous AS (
       SELECT run_id, status FROM publications
       WHERE run_id=$1 AND connector_id=$2 AND status IN ('pending','publishing')
       FOR UPDATE
     )
     UPDATE publications p
     SET status='skipped', claim_token=NULL, claimed_at=NULL,
         finished_at=clock_timestamp(),
         failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
     FROM previous
     WHERE p.run_id=previous.run_id
     RETURNING previous.status AS from_status`,
    [runId, connectorId]
  )
  const fromStatus = result.rows[0]?.from_status ?? null
  // A step left `running` with a claim token whose publication no longer exists would read as
  // "someone owns this work" forever: `requirePublicationStepClaim` would never be attempted
  // again, and an operator debugging the row would look for an owner that is gone. The step's
  // status is kept deliberately - it records how far the step got.
  if (fromStatus !== null) {
    await client.query(
      `UPDATE publication_steps SET claimed_by=NULL, updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND claimed_by IS NOT NULL`,
      [runId, connectorId]
    )
  }
  return fromStatus
}

/** The batch form of `abandonInFlightPublication`, for a caller concluding many runs at once.
 *
 * It applies the same eligibility (`pending` or `publishing`) as the single-run form on purpose:
 * the two used to differ - the batch path only touched `pending` - so "the same" transition
 * quietly meant two things.
 *
 * It returns each moved run with the status it had before, not just its id: a publication can be
 * abandoned from either state, so the caller cannot know which without being told, and an audit
 * event that assumes `pending` would misreport every in-flight publication it converged. */
export async function abandonInFlightPublications(
  client: Pick<PoolClient, 'query'>,
  connectorId: string,
  runIds: readonly string[]
): Promise<Map<string, PublicationStatus>> {
  if (runIds.length === 0) return new Map()
  const result = await client.query<{
    run_id: string
    from_status: PublicationStatus
  }>(
    `WITH previous AS (
       SELECT run_id, status FROM publications
       WHERE run_id=ANY($1::text[]) AND connector_id=$2
         AND status IN ('pending','publishing')
       FOR UPDATE
     )
     UPDATE publications p
     SET status='skipped', claim_token=NULL, claimed_at=NULL,
         finished_at=clock_timestamp(),
         failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
     FROM previous
     WHERE p.run_id=previous.run_id
     RETURNING p.run_id, previous.status AS from_status`,
    [runIds, connectorId]
  )
  const moved = result.rows.map((row) => [row.run_id, row.from_status] as const)
  if (moved.length > 0) {
    // Same reason as the single-run form: drop the step claims of the publications this call
    // actually converged, and only those.
    await client.query(
      `UPDATE publication_steps SET claimed_by=NULL, updated_at=clock_timestamp()
       WHERE connector_id=$2 AND run_id=ANY($1::text[]) AND claimed_by IS NOT NULL`,
      [moved.map(([id]) => id), connectorId]
    )
  }
  return new Map(moved)
}
