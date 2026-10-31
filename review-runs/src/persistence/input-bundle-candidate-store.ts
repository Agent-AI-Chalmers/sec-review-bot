// Owns input-publication intent. Every mutation locks the same preparation row as takeover;
// external object reads/writes happen in the connector, outside this transaction.
import type { PoolClient } from 'pg'
import type { Database } from '../database/database.js'
import type { InputBundleCandidate } from '../contract-types-generated.js'
import { transaction } from '../database/transaction.js'

export async function requirePreparationClaim(
  client: PoolClient,
  runId: string,
  connectorId: string,
  token: string,
  timeoutMs: number
): Promise<void> {
  // Acquire first, then evaluate the lease using database time. A lock wait must not
  // preserve a lease check that passed before the wait began.
  await client.query(
    `SELECT run_id FROM preparations WHERE run_id=$1 AND connector_id=$2 FOR UPDATE`,
    [runId, connectorId]
  )
  const result = await client.query(
    `SELECT run_id FROM preparations
     WHERE run_id=$1 AND connector_id=$2 AND status='preparing' AND claim_token=$3
       AND claimed_at > clock_timestamp()-($4*interval '1 millisecond')
     FOR UPDATE`,
    [runId, connectorId, token, timeoutMs]
  )
  if (result.rowCount !== 1)
    throw new Error(`Preparation claim was lost for ${runId}.`)
}

const projection = 'run_id,digest,reference,input,publish_context,status'
type InputPublicationIntent = Pick<
  InputBundleCandidate,
  'reference' | 'input' | 'publish_context'
>

export class InputBundleCandidateStore {
  constructor(
    private readonly database: Database,
    private readonly connectorId: string,
    private readonly claimTimeoutMs: number
  ) {}

  async reserve(
    runId: string,
    token: string,
    intent: InputPublicationIntent
  ): Promise<InputBundleCandidate> {
    const ref = intent.reference
    if (
      !/^sha256:[0-9a-f]{64}$/.test(ref.digest) ||
      ref.media_type !== 'application/tar+zstd' ||
      !Number.isSafeInteger(ref.size_bytes) ||
      ref.size_bytes < 0
    )
      throw new Error('Invalid input bundle reference.')
    if (ref.uri.trim() !== ref.uri || /\s/.test(ref.uri))
      throw new Error('Invalid input bundle URI.')
    const uri = new URL(ref.uri)
    if (
      !['s3:', 'file:'].includes(uri.protocol) ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password ||
      uri.port
    )
      throw new Error('Invalid input bundle URI.')
    if (
      uri.protocol === 's3:' &&
      uri.pathname !==
        `/runs/${runId}/input/${ref.digest.slice(7)}/input-bundle.v1.tar.zst`
    )
      throw new Error('Input bundle URI does not match its run and digest.')
    return await transaction(this.database.pool(), async (client) => {
      await requirePreparationClaim(
        client,
        runId,
        this.connectorId,
        token,
        this.claimTimeoutMs
      )
      const result = await client.query<InputBundleCandidate>(
        `INSERT INTO input_bundle_candidates (run_id,connector_id,digest,reference,input,publish_context,reserved_by,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved')
         ON CONFLICT (run_id,digest) DO UPDATE SET status=CASE WHEN input_bundle_candidates.status='abandoned' THEN 'reserved' ELSE input_bundle_candidates.status END,
           updated_at=CASE WHEN input_bundle_candidates.status='abandoned' THEN clock_timestamp() ELSE input_bundle_candidates.updated_at END
         WHERE input_bundle_candidates.connector_id=EXCLUDED.connector_id
           AND input_bundle_candidates.reference=EXCLUDED.reference
           AND input_bundle_candidates.input=EXCLUDED.input
           AND input_bundle_candidates.publish_context=EXCLUDED.publish_context

         RETURNING ${projection}`,
        [
          runId,
          this.connectorId,
          ref.digest,
          JSON.stringify(ref),
          JSON.stringify(intent.input),
          JSON.stringify(intent.publish_context),
          token
        ]
      )
      if (!result.rows[0])
        throw new Error(
          'Input bundle reservation conflicts with an immutable intent.'
        )
      return result.rows[0]
    })
  }

  async list(runId: string, token: string): Promise<InputBundleCandidate[]> {
    return await transaction(this.database.pool(), async (client) => {
      await requirePreparationClaim(
        client,
        runId,
        this.connectorId,
        token,
        this.claimTimeoutMs
      )
      const result = await client.query<InputBundleCandidate>(
        `SELECT ${projection} FROM input_bundle_candidates
         WHERE run_id=$1 AND connector_id=$2 AND status <> 'abandoned'
         ORDER BY (status='selected') DESC, created_at, digest`,
        [runId, this.connectorId]
      )
      return result.rows
    })
  }

  async settle(
    runId: string,
    token: string,
    digest: string,
    status: 'present' | 'abandoned'
  ): Promise<InputBundleCandidate> {
    return await transaction(this.database.pool(), async (client) => {
      await requirePreparationClaim(
        client,
        runId,
        this.connectorId,
        token,
        this.claimTimeoutMs
      )
      const result = await client.query<InputBundleCandidate>(
        `UPDATE input_bundle_candidates SET status=$4,
           updated_at=CASE WHEN status=$4 THEN updated_at ELSE clock_timestamp() END
         WHERE run_id=$1 AND connector_id=$2 AND digest=$3
           AND (status IN ('reserved','present') OR status=$4)
         RETURNING ${projection}`,
        [runId, this.connectorId, digest, status]
      )
      if (!result.rows[0])
        throw new Error('Input bundle candidate cannot make this transition.')
      return result.rows[0]
    })
  }
}
