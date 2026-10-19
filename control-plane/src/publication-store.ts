// Owns publication lease transitions once a run is known. Run selection and
// work projection remain with ReviewRunStore because they join review state.
import crypto from 'node:crypto'
import { Pool } from 'pg'

export class PublicationStore {
  constructor(
    private readonly pool: Pool,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  async claim(runId: string): Promise<string | null> {
    const token = crypto.randomUUID()
    const result = await this.pool.query(
      `UPDATE publications p SET status='publishing', claim_token=$3,
         claimed_at=clock_timestamp(), failure_code=NULL, failure_message=NULL,
         updated_at=clock_timestamp()
       FROM review_runs r
       WHERE p.run_id=$1 AND p.connector_id=$2 AND r.run_id=p.run_id
         AND r.connector_id=$2 AND r.runner_status='succeeded'
         AND jsonb_typeof(r.workflow_result) <> 'null'
         AND (p.status='pending' OR (p.status='publishing' AND
           p.claimed_at <= clock_timestamp()-($4*interval '1 millisecond')))
       RETURNING p.run_id`,
      [runId, this.connectorId, token, this.claimTimeoutMs]
    )
    return result.rowCount === 1 ? token : null
  }

  heartbeatIntervalMs(): number {
    return Math.max(100, Math.min(30_000, Math.floor(this.claimTimeoutMs / 3)))
  }

  async renewClaim(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publications SET claimed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='publishing' AND claim_token=$3`,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  async complete(runId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publications SET status='published', claim_token=NULL, published_at=clock_timestamp(),
         failure_code=NULL, failure_message=NULL, updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='publishing' AND claim_token=$3
         AND NOT EXISTS (SELECT 1 FROM publication_steps
           WHERE run_id=$1 AND connector_id=$2 AND status <> 'succeeded')`,
      [runId, this.connectorId, token]
    )
    return result.rowCount === 1
  }

  async fail(
    runId: string,
    token: string,
    error: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE publications SET status=$4, claim_token=NULL, failure_code=$5,
         failure_message=$6, updated_at=clock_timestamp()
       WHERE run_id=$1 AND connector_id=$2 AND status='publishing' AND claim_token=$3`,
      [
        runId,
        this.connectorId,
        token,
        options.retry ? 'pending' : 'failed',
        error.code ?? null,
        error.message
      ]
    )
    return result.rowCount === 1
  }
}
