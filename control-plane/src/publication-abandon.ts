// One cross-axis transition shared by the stores: conclude a publication that can never publish.
//
// It lives in its own module because it is neither a preparation nor an execution concern, yet
// both of those axes trigger it when they prove the Runner will produce no result. Putting it in
// `publication-store.ts` would make `preparation-store.ts` import the publication store, breaking
// the rule that single-axis stores do not depend on each other; `ReviewRunStore` orchestrates
// cross-axis transitions, but the stores themselves cannot import it (it constructs them).
// A small module both can import keeps the dependency graph one-directional.
import type { PoolClient } from 'pg'

import type { PublicationStatus } from './shapes.js'

/** Converge a publication that has not concluded yet to `skipped`, in the caller's transaction.
 *
 * Three paths reach this: a preparation failure that proves the Runner was never called, an
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
  return result.rows[0]?.from_status ?? null
}
