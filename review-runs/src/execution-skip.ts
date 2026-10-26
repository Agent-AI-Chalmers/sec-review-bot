// One cross-axis transition shared by the stores: conclude an execution that never ran.
//
// When preparation fails, the Execution is never called, so execution is `skipped` rather than
// `failed` - there is no execution failure to report, and the reason stays on the preparation
// axis. Two preparation paths reach it (a terminal failure with a live claim, and a lease that
// expired on the final attempt), and both used to spell the UPDATE out themselves. Keeping one
// implementation is what stops the two from drifting: the batch path only matched `pending`
// while the single-run path had no batch form, so "the same" transition already differed.
//
// Publication is converged alongside because a publication that could still publish is not
// applicable once execution is skipped. That convergence lives in `publication-abandon.ts`, and
// callers apply it in the same transaction.
import type { PoolClient } from 'pg'

/** Mark pending executions as `skipped`, in the caller's transaction.
 *
 * Only `pending` is eligible: that is the only execution state that has not handed input to the
 * Execution. A run whose execution is already `queued` or beyond cannot be "skipped" by a later
 * preparation failure without contradicting the fact that it was submitted, so it is left alone
 * and the returned ids say which rows this call actually moved.
 *
 * Returns the run ids it skipped. Callers compare against what they asked for, so a run that was
 * not in `pending` surfaces as a lost transition instead of being silently ignored. */
export async function skipPendingExecutions(
  client: Pick<PoolClient, 'query'>,
  connectorId: string,
  runIds: readonly string[]
): Promise<string[]> {
  if (runIds.length === 0) return []
  const result = await client.query<{ run_id: string }>(
    `UPDATE executions SET status='skipped',
       failure_code=NULL, failure_message=NULL,
       finished_at=clock_timestamp(),
       observed_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE run_id=ANY($1::text[]) AND connector_id=$2 AND status='pending'
     RETURNING run_id`,
    [runIds, connectorId]
  )
  return result.rows.map((row) => row.run_id)
}
