import { Pool, type PoolClient } from 'pg'

import type { components } from './contract-types-generated.js'
import { applySchemaVersions } from './database/schema-version-runner.js'

type ArtifactReference = components['schemas']['ArtifactReference']
type ExtractionRegistration = components['schemas']['ExtractionRegistration']
type ExtractionRecord = components['schemas']['ExtractionRecord']
type ObservationBacklog = components['schemas']['ObservationBacklog']
type MaintenanceInput = components['schemas']['MaintenanceInput']
type MemoryTreeRevisionCreation =
  components['schemas']['MemoryTreeRevisionCreation']
type MemoryTreeRevisionCreationResult =
  components['schemas']['MemoryTreeRevisionCreationResult']
type MemoryTree = components['schemas']['MemoryTree']
type MemoryTreeRevision = components['schemas']['MemoryTreeRevision']
type MemoryTreeRevisionList = components['schemas']['MemoryTreeRevisionList']

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
  registerExtraction(input: ExtractionRegistration): Promise<boolean>
  getExtraction(extractionId: string): Promise<ExtractionRecord | undefined>
  getObservationBacklog(): Promise<ObservationBacklog>
  getMaintenanceInput(limit: number): Promise<MaintenanceInput | null>
  createMemoryTreeRevision(
    input: MemoryTreeRevisionCreation,
  ): Promise<MemoryTreeRevisionCreationResult>
  getMemoryTree(): Promise<MemoryTree>
  getMemoryTreeRevision(
    revision: number,
  ): Promise<MemoryTreeRevision | undefined>
  listMemoryTreeRevisions(
    beforeRevision: number | undefined,
    limit: number,
  ): Promise<MemoryTreeRevisionList>
}

export class ExtractionConflictError extends Error {}
export class MemoryTreeRevisionConflictError extends Error {}

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

  async registerExtraction(input: ExtractionRegistration): Promise<boolean> {
    return await inTransaction(this.#pool, async (client) => {
      const inserted = await client.query(
        `insert into extractions (
           extraction_id, source_workflow, source_run_id, source_review_unit_id,
           diagnostic_bundle_digest, transcript_reference
         ) values ($1,$2,$3,$4,$5,$6)
         on conflict (extraction_id) do nothing`,
        [
          input.extraction_id,
          input.source_workflow,
          input.source_run_id,
          input.source_review_unit_id,
          input.diagnostic_bundle_digest,
          input.transcript_reference,
        ],
      )
      if (inserted.rowCount === 1) {
        if (input.observation !== null) {
          await client.query(
            `insert into observations (extraction_id, body_markdown)
             values ($1,$2)`,
            [input.extraction_id, input.observation.body_markdown],
          )
        }
        return true
      }
      const existing = await client.query<{ identical: boolean }>(
        `select source_workflow=$2 and source_run_id=$3 and
                source_review_unit_id=$4 and diagnostic_bundle_digest=$5 and
                transcript_reference=$6::jsonb and
                (($7::text is null and observation.body_markdown is null) or
                 observation.body_markdown=$7) as identical
         from extractions extraction
         left join observations observation using (extraction_id)
         where extraction_id=$1`,
        [
          input.extraction_id,
          input.source_workflow,
          input.source_run_id,
          input.source_review_unit_id,
          input.diagnostic_bundle_digest,
          JSON.stringify(input.transcript_reference),
          input.observation?.body_markdown ?? null,
        ],
      )
      if (existing.rows[0]?.identical !== true) {
        throw new ExtractionConflictError(
          `Extraction id already exists with different content: ${input.extraction_id}`,
        )
      }
      return false
    })
  }

  async getExtraction(
    extractionId: string,
  ): Promise<ExtractionRecord | undefined> {
    const result = await this.#pool.query<{
      extraction_id: string
      source_workflow: string
      source_run_id: string
      source_review_unit_id: string
      diagnostic_bundle_digest: string
      transcript_reference: ArtifactReference
      body_markdown: string | null
      created_at: Date
    }>(
      `select extraction.extraction_id, extraction.source_workflow,
              extraction.source_run_id, extraction.source_review_unit_id,
              extraction.diagnostic_bundle_digest, extraction.transcript_reference,
              observation.body_markdown, extraction.created_at
       from extractions extraction
       left join observations observation using (extraction_id)
       where extraction.extraction_id=$1`,
      [extractionId],
    )
    const row = result.rows[0]
    return row
      ? {
          extraction_id: row.extraction_id,
          source_workflow: row.source_workflow,
          source_run_id: row.source_run_id,
          source_review_unit_id: row.source_review_unit_id,
          diagnostic_bundle_digest: row.diagnostic_bundle_digest,
          transcript_reference: row.transcript_reference,
          observation:
            row.body_markdown === null
              ? null
              : { body_markdown: row.body_markdown },
          created_at: row.created_at.toISOString(),
        }
      : undefined
  }

  async getObservationBacklog(): Promise<ObservationBacklog> {
    const result = await this.#pool.query<{
      pending_count: string
      oldest_pending_created_at: Date | null
    }>(`select count(*) as pending_count,
               min(created_at) as oldest_pending_created_at
        from observations where consumed_revision is null`)
    const row = result.rows[0]
    if (row === undefined)
      throw new Error('Observation backlog query returned no row.')
    return {
      pending_count: Number(row.pending_count),
      oldest_pending_created_at:
        row.oldest_pending_created_at?.toISOString() ?? null,
    }
  }

  async getMaintenanceInput(limit: number): Promise<MaintenanceInput | null> {
    return await inTransaction(this.#pool, async (client) => {
      const observations = await client.query<{
        extraction_id: string
        body_markdown: string
      }>(
        `select extraction_id, body_markdown
         from observations
         where consumed_revision is null
         order by created_at, extraction_id limit $1`,
        [limit],
      )
      if (observations.rowCount === 0) return null
      const active = await client.query<{
        revision: string
        memory_tree_reference: ArtifactReference | null
      }>(`select state.active_revision as revision, revision.memory_tree_reference
          from memory_tree_state state
          left join memory_tree_revisions revision
            on revision.revision=state.active_revision
          where state.singleton=true`)
      const row = active.rows[0]
      if (row === undefined)
        throw new Error('Memory tree state row is missing.')
      return {
        base_revision: Number(row.revision),
        active_memory_tree_reference: row.memory_tree_reference,
        observations: observations.rows,
      }
    })
  }

  async createMemoryTreeRevision(
    input: MemoryTreeRevisionCreation,
  ): Promise<MemoryTreeRevisionCreationResult> {
    return await inTransaction(this.#pool, async (client) => {
      const replay = await client.query<{
        revision: string
        identical: boolean
      }>(
        `select revision.revision,
                revision.base_revision=$2 and
                revision.memory_tree_reference=$3::jsonb and
                revision.maintenance_transcript_reference=$4::jsonb and
                coalesce(array_agg(observation.extraction_id order by observation.extraction_id)
                  filter (where observation.extraction_id is not null), '{}')=$5::text[]
                  as identical
         from memory_tree_revisions revision
         left join observations observation
           on observation.consumed_revision=revision.revision
         where revision.maintenance_id=$1
         group by revision.revision`,
        [
          input.maintenance_id,
          input.base_revision,
          JSON.stringify(input.memory_tree_reference),
          JSON.stringify(input.maintenance_transcript_reference),
          [...input.extraction_ids].sort(),
        ],
      )
      const existing = replay.rows[0]
      if (existing !== undefined) {
        if (!existing.identical) {
          throw new MemoryTreeRevisionConflictError(
            `Maintenance id already exists with different content: ${input.maintenance_id}`,
          )
        }
        return {
          created: false,
          revision: Number(existing.revision),
          maintenance_id: input.maintenance_id,
        }
      }

      const active = await client.query<{ revision: string }>(
        `select active_revision as revision from memory_tree_state
         where singleton=true for update`,
      )
      if (Number(active.rows[0]?.revision) !== input.base_revision) {
        throw new MemoryTreeRevisionConflictError(
          `Active revision no longer matches base revision ${input.base_revision}.`,
        )
      }
      const selected = await client.query<{ extraction_id: string }>(
        `select extraction_id from observations
         where extraction_id=any($1) and consumed_revision is null for update`,
        [input.extraction_ids],
      )
      if (
        selected.rowCount !== input.extraction_ids.length ||
        !input.extraction_ids.every((id) =>
          selected.rows.some((row) => row.extraction_id === id),
        )
      ) {
        throw new MemoryTreeRevisionConflictError(
          'One or more source observations are no longer pending.',
        )
      }
      const nextRevision = input.base_revision + 1
      await client.query(
        `insert into memory_tree_revisions (
           revision, maintenance_id, base_revision, memory_tree_reference,
           maintenance_transcript_reference
         ) values ($1,$2,$3,$4,$5)`,
        [
          nextRevision,
          input.maintenance_id,
          input.base_revision,
          input.memory_tree_reference,
          input.maintenance_transcript_reference,
        ],
      )
      await client.query(
        `update observations set consumed_revision=$1
         where extraction_id=any($2) and consumed_revision is null`,
        [nextRevision, input.extraction_ids],
      )
      await client.query(
        `update memory_tree_state
         set active_revision=$1, updated_at=clock_timestamp()
         where singleton=true`,
        [nextRevision],
      )
      return {
        created: true,
        revision: nextRevision,
        maintenance_id: input.maintenance_id,
      }
    })
  }

  async getMemoryTree(): Promise<MemoryTree> {
    const result = await this.#pool.query<{
      revision: string
      memory_tree_reference: ArtifactReference | null
    }>(`select state.active_revision as revision, revision.memory_tree_reference
        from memory_tree_state state
        left join memory_tree_revisions revision
          on revision.revision=state.active_revision
        where state.singleton=true`)
    const row = result.rows[0]
    if (row === undefined) throw new Error('Memory tree state row is missing.')
    return {
      revision: Number(row.revision),
      memory_tree_reference: row.memory_tree_reference,
    }
  }

  async getMemoryTreeRevision(
    revision: number,
  ): Promise<MemoryTreeRevision | undefined> {
    const result = await this.#pool.query<{
      revision: string
      maintenance_id: string
      base_revision: string
      extraction_ids: string[]
      memory_tree_reference: ArtifactReference
      maintenance_transcript_reference: ArtifactReference
      created_at: Date
    }>(
      `select revision.revision, revision.maintenance_id, revision.base_revision,
              coalesce(array_agg(observation.extraction_id order by observation.extraction_id)
                filter (where observation.extraction_id is not null), '{}') as extraction_ids,
              revision.memory_tree_reference,
              revision.maintenance_transcript_reference, revision.created_at
       from memory_tree_revisions revision
       left join observations observation
         on observation.consumed_revision=revision.revision
       where revision.revision=$1
       group by revision.revision`,
      [revision],
    )
    const row = result.rows[0]
    return row ? projectRevision(row) : undefined
  }

  async listMemoryTreeRevisions(
    beforeRevision: number | undefined,
    limit: number,
  ): Promise<MemoryTreeRevisionList> {
    const result = await this.#pool.query<{
      revision: string
      maintenance_id: string
      base_revision: string
      extraction_ids: string[]
      memory_tree_reference: ArtifactReference
      maintenance_transcript_reference: ArtifactReference
      created_at: Date
    }>(
      `select revision.revision, revision.maintenance_id, revision.base_revision,
              coalesce(array_agg(observation.extraction_id order by observation.extraction_id)
                filter (where observation.extraction_id is not null), '{}') as extraction_ids,
              revision.memory_tree_reference,
              revision.maintenance_transcript_reference, revision.created_at
       from memory_tree_revisions revision
       left join observations observation
         on observation.consumed_revision=revision.revision
       where ($1::bigint is null or revision.revision < $1)
       group by revision.revision
       order by revision.revision desc limit $2`,
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
  maintenance_id: string
  base_revision: string
  extraction_ids: string[]
  memory_tree_reference: ArtifactReference
  maintenance_transcript_reference: ArtifactReference
  created_at: Date
}): MemoryTreeRevision {
  return {
    revision: Number(row.revision),
    maintenance_id: row.maintenance_id,
    base_revision: Number(row.base_revision),
    extraction_ids: row.extraction_ids,
    memory_tree_reference: row.memory_tree_reference,
    maintenance_transcript_reference: row.maintenance_transcript_reference,
    created_at: row.created_at.toISOString(),
  }
}
