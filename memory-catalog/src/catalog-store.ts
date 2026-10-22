import { Pool, type PoolClient } from 'pg'

import type { components } from './contract-types-generated.js'
import { applySchemaVersions } from './database/schema-version-runner.js'

type ArtifactReference = components['schemas']['ArtifactReference']
type ObservationRegistration = components['schemas']['ObservationRegistration']
type PendingObservationSummary =
  components['schemas']['PendingObservationSummary']
type MaintenanceBatch = components['schemas']['MaintenanceBatch']
type ActiveVersion = components['schemas']['ActiveVersion']
type MemoryRevision = components['schemas']['MemoryRevision']
type MemoryRevisionList = components['schemas']['MemoryRevisionList']

async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await operation(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export interface MemoryCatalogStore {
  initialize(): Promise<void>
  close(): Promise<void>
  registerObservation(input: ObservationRegistration): Promise<boolean>
  pendingObservationSummary(): Promise<PendingObservationSummary>
  selectMaintenanceBatch(limit: number): Promise<MaintenanceBatch | null>
  completeMaintenance(input: {
    base_revision: number
    observation_ids: string[]
    memory_version: ArtifactReference
    audit_reference: ArtifactReference
  }): Promise<boolean>
  activeVersion(): Promise<ActiveVersion>
  getRevision(revision: number): Promise<MemoryRevision | undefined>
  listRevisions(
    beforeRevision: number | undefined,
    limit: number,
  ): Promise<MemoryRevisionList>
}

export class ObservationConflictError extends Error {}

export class PostgresMemoryCatalogStore implements MemoryCatalogStore {
  readonly #pool: Pool

  constructor(connectionString: string, pool?: Pool) {
    this.#pool = pool ?? new Pool({ connectionString })
  }

  async initialize(): Promise<void> {
    await applySchemaVersions(this.#pool)
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }

  async registerObservation(input: ObservationRegistration): Promise<boolean> {
    return await inTransaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `insert into observations (
           observation_id, source_workflow, source_run_id, source_review_unit_id,
           transcript_digest, body_markdown, audit_reference
         ) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (observation_id) do nothing`,
        [
          input.observation_id,
          input.source_workflow,
          input.source_run_id,
          input.source_review_unit_id,
          input.transcript_digest,
          input.body_markdown,
          input.audit_reference,
        ],
      )
      if (inserted.rowCount === 1) return true
      const existing = await client.query<{ identical: boolean }>(
        `select source_workflow=$2 and source_run_id=$3 and
                source_review_unit_id=$4 and transcript_digest=$5 and
                body_markdown=$6 and audit_reference=$7::jsonb as identical
         from observations where observation_id=$1`,
        [
          input.observation_id,
          input.source_workflow,
          input.source_run_id,
          input.source_review_unit_id,
          input.transcript_digest,
          input.body_markdown,
          JSON.stringify(input.audit_reference),
        ],
      )
      if (existing.rows[0]?.identical !== true) {
        throw new ObservationConflictError(
          `Observation id already exists with different content: ${input.observation_id}`,
        )
      }
      return false
    })
  }

  async pendingObservationSummary(): Promise<PendingObservationSummary> {
    const result = await this.#pool.query<{
      pending_count: string
      oldest_pending_created_at: Date | null
    }>(`select count(*) as pending_count,
               min(created_at) as oldest_pending_created_at
        from observations where consumed_revision is null`)
    const row = result.rows[0]
    if (row === undefined)
      throw new Error('Pending summary query returned no row.')
    return {
      pending_count: Number(row.pending_count),
      oldest_pending_created_at:
        row.oldest_pending_created_at?.toISOString() ?? null,
    }
  }

  async selectMaintenanceBatch(
    limit: number,
  ): Promise<MaintenanceBatch | null> {
    return await inTransaction(this.#pool, async (client) => {
      const observations = await client.query<{
        observation_id: string
        body_markdown: string
      }>(
        `select observation_id, body_markdown
         from observations
         where consumed_revision is null
         order by created_at, observation_id limit $1`,
        [limit],
      )
      if (observations.rowCount === 0) return null
      const active = await client.query<{
        revision: string
        artifact_reference: ArtifactReference | null
      }>(`select active.revision, revision.artifact_reference
          from active_revision active
          left join revisions revision
            on revision.revision=active.revision
          where active.singleton=true`)
      const row = active.rows[0]
      if (row === undefined) throw new Error('Active memory row is missing.')
      return {
        base_revision: Number(row.revision),
        active_memory: row.artifact_reference,
        observations: observations.rows,
      }
    })
  }

  async completeMaintenance(input: {
    base_revision: number
    observation_ids: string[]
    memory_version: ArtifactReference
    audit_reference: ArtifactReference
  }): Promise<boolean> {
    return await inTransaction(this.#pool, async (client) => {
      const active = await client.query<{ revision: string }>(
        `select revision from active_revision
         where singleton=true for update`,
      )
      if (Number(active.rows[0]?.revision) !== input.base_revision) return false
      const selected = await client.query<{ observation_id: string }>(
        `select observation_id from observations
         where observation_id=any($1) and consumed_revision is null for update`,
        [input.observation_ids],
      )
      if (
        selected.rowCount !== input.observation_ids.length ||
        !input.observation_ids.every((id) =>
          selected.rows.some((row) => row.observation_id === id),
        )
      ) {
        return false
      }
      const nextRevision = input.base_revision + 1
      await client.query(
        `insert into revisions (
           revision, artifact_reference, maintenance_audit_reference
         ) values ($1,$2,$3)`,
        [nextRevision, input.memory_version, input.audit_reference],
      )
      await client.query(
        `update observations set consumed_revision=$1
         where observation_id=any($2) and consumed_revision is null`,
        [nextRevision, input.observation_ids],
      )
      await client.query(
        `update active_revision
         set revision=$1, updated_at=clock_timestamp()
         where singleton=true`,
        [nextRevision],
      )
      return true
    })
  }

  async activeVersion(): Promise<ActiveVersion> {
    const result = await this.#pool.query<{
      revision: string
      artifact_reference: ArtifactReference | null
    }>(`select active.revision, revision.artifact_reference
        from active_revision active
        left join revisions revision
          on revision.revision=active.revision
        where active.singleton=true`)
    const row = result.rows[0]
    if (row === undefined) throw new Error('Active memory row is missing.')
    return {
      revision: Number(row.revision),
      artifact_reference: row.artifact_reference,
    }
  }

  async getRevision(revision: number): Promise<MemoryRevision | undefined> {
    const result = await this.#pool.query<{
      revision: string
      artifact_reference: ArtifactReference
      maintenance_audit_reference: ArtifactReference
      created_at: Date
    }>(
      `select revision, artifact_reference, maintenance_audit_reference, created_at
        from revisions where revision=$1`,
      [revision],
    )
    const row = result.rows[0]
    return row ? projectRevision(row) : undefined
  }

  async listRevisions(
    beforeRevision: number | undefined,
    limit: number,
  ): Promise<MemoryRevisionList> {
    const result = await this.#pool.query<{
      revision: string
      artifact_reference: ArtifactReference
      maintenance_audit_reference: ArtifactReference
      created_at: Date
    }>(
      `select revision, artifact_reference, maintenance_audit_reference, created_at
        from revisions
        where ($1::bigint is null or revision < $1)
        order by revision desc limit $2`,
      [beforeRevision ?? null, limit + 1],
    )
    const rows = result.rows.slice(0, limit)
    return {
      revisions: rows.map(projectRevision),
      next_before_revision:
        result.rows.length > limit && rows.length > 0
          ? Number(rows[rows.length - 1]?.revision)
          : null,
    }
  }
}

function projectRevision(row: {
  revision: string
  artifact_reference: ArtifactReference
  maintenance_audit_reference: ArtifactReference
  created_at: Date
}): MemoryRevision {
  return {
    revision: Number(row.revision),
    artifact_reference: row.artifact_reference,
    maintenance_audit_reference: row.maintenance_audit_reference,
    created_at: row.created_at.toISOString(),
  }
}
