import { Pool, type PoolClient } from 'pg'

import type {
  ExtractionPublication,
  ExtractionPublicationIntent,
  RevisionPublication,
  Actor,
  ArtifactReference,
  ExtractionRegistration,
  MaintenanceControlOperation,
  MaintenanceControlOperationResult,
  MaintenanceInput,
  MemoryTreeRestoreOperation,
  MemoryTreeRestoreOperationResult,
  MemoryTreeRevisionCreation,
  MemoryTreeRevisionCreationResult,
  OperatorRevisionSource,
} from './contract-types-generated.js'
import {
  PostgresMemoryCatalogQueries,
  type MemoryCatalogQueries,
} from './catalog-queries.js'
import { applySchemaVersions } from './database/schema-version-runner.js'

export type AuthenticatedMaintenanceControlOperation =
  MaintenanceControlOperation & { actor: Actor }
export type AuthenticatedMemoryTreeRestoreOperation =
  MemoryTreeRestoreOperation & { actor: Actor }
export type AuthenticatedMemoryTreeRevisionCreation = Omit<
  MemoryTreeRevisionCreation,
  'source'
> & {
  source:
    | Extract<MemoryTreeRevisionCreation['source'], { kind: 'maintenance' }>
    | OperatorRevisionSource
}

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
  readonly queries: MemoryCatalogQueries
  initialize(): Promise<void>
  close(): Promise<void>
  reserveExtractionPublication(
    intent: ExtractionPublicationIntent,
  ): Promise<ExtractionPublication>
  confirmExtractionPublication(
    intent: ExtractionPublicationIntent,
  ): Promise<ExtractionPublication>
  listExtractionPublications(
    extractionId: string,
  ): Promise<ExtractionPublication[]>
  reserveRevisionPublication(
    intent: AuthenticatedMemoryTreeRevisionCreation,
  ): Promise<RevisionPublication>
  confirmRevisionPublication(
    intent: AuthenticatedMemoryTreeRevisionCreation,
  ): Promise<RevisionPublication>
  listRevisionPublications(
    kind: 'maintenance' | 'operator',
    ownerId: string,
  ): Promise<RevisionPublication[]>
  registerExtraction(input: ExtractionRegistration): Promise<boolean>
  changeMaintenanceControl(
    targetState: 'enabled' | 'paused',
    input: AuthenticatedMaintenanceControlOperation,
  ): Promise<MaintenanceControlOperationResult>
  getMaintenanceInput(limit: number): Promise<MaintenanceInput | null>
  createMemoryTreeRevision(
    input: AuthenticatedMemoryTreeRevisionCreation,
  ): Promise<MemoryTreeRevisionCreationResult>
  restoreMemoryTree(
    input: AuthenticatedMemoryTreeRestoreOperation,
  ): Promise<MemoryTreeRestoreOperationResult>
}

export class ExtractionConflictError extends Error {}
export class MemoryTreeRevisionConflictError extends Error {}
export class MaintenanceControlConflictError extends Error {}
export class MaintenancePausedError extends Error {}

/** Owns the pool lifecycle, publication ledgers, and atomic catalog transitions.
 * Read-only views live in queries; maintenance input retains its transaction here. */
export class PostgresMemoryCatalogStore implements MemoryCatalogStore {
  readonly #pool: Pool
  readonly queries: MemoryCatalogQueries

  constructor(connectionString: string, pool?: Pool) {
    this.#pool = pool ?? new Pool({ connectionString })
    this.queries = new PostgresMemoryCatalogQueries(this.#pool)
  }

  async initialize(): Promise<void> {
    await applySchemaVersions(this.#pool)
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }

  async reserveExtractionPublication(
    intent: ExtractionPublicationIntent,
  ): Promise<ExtractionPublication> {
    return await inTransaction(this.#pool, async (client) => {
      const identity = [
        intent.registration.extraction_id,
        intent.registration.trajectory_reference.digest,
      ]
      await client.query(
        `insert into extraction_publications (extraction_id, digest, intent)
        values ($1,$2,$3) on conflict do nothing`,
        [...identity, intent],
      )
      const result = await client.query<
        ExtractionPublication & { identical: boolean }
      >(
        `select intent, status, intent=$3::jsonb as identical from extraction_publications
         where extraction_id=$1 and digest=$2 for update`,
        [...identity, intent],
      )
      const row = result.rows[0]!
      if (!row.identical)
        throw new ExtractionConflictError(
          'Extraction publication intent changed.',
        )
      return { intent: row.intent, status: row.status }
    })
  }

  async confirmExtractionPublication(
    intent: ExtractionPublicationIntent,
  ): Promise<ExtractionPublication> {
    const result = await this.#pool.query<ExtractionPublication>(
      `update extraction_publications set status=case when status='selected' then status else 'present' end
       where extraction_id=$1 and digest=$2 and intent=$3::jsonb returning intent,status`,
      [
        intent.registration.extraction_id,
        intent.registration.trajectory_reference.digest,
        intent,
      ],
    )
    if (!result.rows[0])
      throw new ExtractionConflictError(
        'Matching extraction publication reservation is required.',
      )
    return result.rows[0]
  }

  async listExtractionPublications(
    extractionId: string,
  ): Promise<ExtractionPublication[]> {
    const result = await this.#pool.query<ExtractionPublication>(
      `select intent,status from extraction_publications where extraction_id=$1
       order by (status='selected') desc, created_at, digest`,
      [extractionId],
    )
    return result.rows
  }

  async reserveRevisionPublication(
    intent: AuthenticatedMemoryTreeRevisionCreation,
  ): Promise<RevisionPublication> {
    return await inTransaction(this.#pool, async (client) => {
      const identity = revisionPublicationIdentity(intent)
      await client.query(
        `insert into memory_revision_publications
        (source_kind, owner_id, tree_digest, trajectory_digest, intent)
        values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [...identity, intent],
      )
      const result = await client.query<{
        intent: AuthenticatedMemoryTreeRevisionCreation
        status: RevisionPublication['status']
        identical: boolean
      }>(
        `select intent, status, intent=$5::jsonb as identical from memory_revision_publications
         where source_kind=$1 and owner_id=$2 and tree_digest=$3 and trajectory_digest=$4 for update`,
        [...identity, intent],
      )
      const row = result.rows[0]!
      if (!row.identical)
        throw new MemoryTreeRevisionConflictError(
          'Revision publication intent changed.',
        )
      return projectRevisionPublication(row)
    })
  }

  async confirmRevisionPublication(
    intent: AuthenticatedMemoryTreeRevisionCreation,
  ): Promise<RevisionPublication> {
    const result = await this.#pool.query<{
      intent: AuthenticatedMemoryTreeRevisionCreation
      status: RevisionPublication['status']
    }>(
      `update memory_revision_publications set status=case when status='selected' then status else 'present' end
       where source_kind=$1 and owner_id=$2 and tree_digest=$3 and trajectory_digest=$4 and intent=$5::jsonb
       returning intent,status`,
      [...revisionPublicationIdentity(intent), intent],
    )
    if (!result.rows[0])
      throw new MemoryTreeRevisionConflictError(
        'Matching revision publication reservation is required.',
      )
    return projectRevisionPublication(result.rows[0])
  }

  async listRevisionPublications(
    kind: 'maintenance' | 'operator',
    ownerId: string,
  ): Promise<RevisionPublication[]> {
    const result = await this.#pool.query<{
      intent: AuthenticatedMemoryTreeRevisionCreation
      status: RevisionPublication['status']
    }>(
      `select intent,status from memory_revision_publications where source_kind=$1 and owner_id=$2
       order by (status='selected') desc, created_at, tree_digest, trajectory_digest`,
      [kind, ownerId],
    )
    return result.rows.map(projectRevisionPublication)
  }

  async registerExtraction(input: ExtractionRegistration): Promise<boolean> {
    return await inTransaction(this.#pool, async (client) => {
      // Serialize candidates by owner even before an authoritative extraction row exists.
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`extraction:${input.extraction_id}`],
      )
      const selected = await client.query(
        `select 1 from extraction_publications
        where extraction_id=$1 and status='selected' and intent->'registration'<>$2::jsonb`,
        [input.extraction_id, input],
      )
      if (selected.rows[0])
        throw new ExtractionConflictError(
          'A different extraction publication is already selected.',
        )
      const publication = await client.query<{ digest: string }>(
        `select digest from extraction_publications where extraction_id=$1
         and intent->'registration'=$2::jsonb and status in ('present','selected') for update`,
        [input.extraction_id, input],
      )
      if (!publication.rows[0])
        throw new ExtractionConflictError(
          'A confirmed extraction publication is required.',
        )
      await client.query(
        `update extraction_publications set status='selected'
        where extraction_id=$1 and digest=$2`,
        [input.extraction_id, publication.rows[0].digest],
      )
      const inserted = await client.query(
        `insert into extractions (
           extraction_id, source_workflow, source_run_id, source_unit_id,
           diagnostic_bundle_digest, trajectory_reference
         ) values ($1,$2,$3,$4,$5,$6)
         on conflict (extraction_id) do nothing`,
        [
          input.extraction_id,
          input.source_workflow,
          input.source_run_id,
          input.source_unit_id,
          input.diagnostic_bundle_digest,
          input.trajectory_reference,
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
                source_unit_id=$4 and diagnostic_bundle_digest=$5 and
                trajectory_reference=$6::jsonb and
                (($7::text is null and observation.body_markdown is null) or
                 observation.body_markdown=$7) as identical
         from extractions extraction
         left join observations observation using (extraction_id)
         where extraction_id=$1`,
        [
          input.extraction_id,
          input.source_workflow,
          input.source_run_id,
          input.source_unit_id,
          input.diagnostic_bundle_digest,
          JSON.stringify(input.trajectory_reference),
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

  async changeMaintenanceControl(
    targetState: 'enabled' | 'paused',
    input: AuthenticatedMaintenanceControlOperation,
  ): Promise<MaintenanceControlOperationResult> {
    return await inTransaction(this.#pool, async (client) => {
      const replay = await client.query<{
        identical: boolean
        resulting_state: 'enabled' | 'paused'
        resulting_generation: string
        actor: Actor
        changed_at: Date
      }>(
        `select target_state=$2 and expected_generation=$3 and
                actor=$4::jsonb as identical,
                resulting_state, resulting_generation, actor, changed_at
         from maintenance_control_operations where operation_id=$1`,
        [
          input.operation_id,
          targetState,
          input.expected_generation,
          JSON.stringify(input.actor),
        ],
      )
      const existing = replay.rows[0]
      if (existing !== undefined) {
        if (!existing.identical)
          throw new MaintenanceControlConflictError(
            'Control operation id already exists with different content.',
          )
        return {
          created: false,
          control: {
            state: existing.resulting_state,
            generation: Number(existing.resulting_generation),
            changed_by: existing.actor,
            changed_at: existing.changed_at.toISOString(),
          },
        }
      }

      const current = await client.query<{
        state: 'enabled' | 'paused'
        generation: string
      }>(
        `select state, generation from maintenance_control
         where singleton=true for update`,
      )
      const row = current.rows[0]
      if (row === undefined)
        throw new Error('Maintenance control row is missing.')
      if (Number(row.generation) !== input.expected_generation)
        throw new MaintenanceControlConflictError(
          `Maintenance control generation no longer matches ${input.expected_generation}.`,
        )
      const expectedState = targetState === 'paused' ? 'enabled' : 'paused'
      if (row.state !== expectedState)
        throw new MaintenanceControlConflictError(
          `Maintenance control cannot transition from ${row.state} to ${targetState}.`,
        )
      const changed = await client.query<{
        state: 'enabled' | 'paused'
        generation: string
        changed_by: Actor
        changed_at: Date
      }>(
        `update maintenance_control
         set state=$1, generation=generation+1, changed_by=$2,
             changed_at=clock_timestamp()
         where singleton=true
         returning state, generation, changed_by, changed_at`,
        [targetState, input.actor],
      )
      const control = changed.rows[0]
      if (control === undefined)
        throw new Error('Maintenance control update returned no row.')
      await client.query(
        `insert into maintenance_control_operations (
           operation_id, target_state, expected_generation, actor,
           resulting_state, resulting_generation, changed_at
         ) values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.operation_id,
          targetState,
          input.expected_generation,
          input.actor,
          control.state,
          Number(control.generation),
          control.changed_at,
        ],
      )
      return {
        created: true,
        control: {
          state: control.state,
          generation: Number(control.generation),
          changed_by: control.changed_by,
          changed_at: control.changed_at.toISOString(),
        },
      }
    })
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
        expected_active_revision: Number(row.revision),
        active_memory_tree_reference: row.memory_tree_reference,
        observations: observations.rows,
      }
    })
  }

  async createMemoryTreeRevision(
    input: AuthenticatedMemoryTreeRevisionCreation,
  ): Promise<MemoryTreeRevisionCreationResult> {
    return await inTransaction(this.#pool, async (client) => {
      const source = input.source
      const identity = revisionPublicationIdentity(input)
      // Competing candidates must observe the winner before trying to select themselves.
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`revision:${identity[0]}:${identity[1]}`],
      )
      const selected = await client.query(
        `select 1 from memory_revision_publications
        where source_kind=$1 and owner_id=$2 and status='selected' and intent<>$3::jsonb`,
        [identity[0], identity[1], input],
      )
      if (selected.rows[0])
        throw new MemoryTreeRevisionConflictError(
          'A different revision publication is already selected.',
        )
      const publication = await client.query(
        `select 1 from memory_revision_publications where source_kind=$1 and owner_id=$2
         and tree_digest=$3 and trajectory_digest=$4 and intent=$5::jsonb
         and status in ('present','selected') for update`,
        [...revisionPublicationIdentity(input), input],
      )
      if (!publication.rows[0])
        throw new MemoryTreeRevisionConflictError(
          'A confirmed revision publication is required.',
        )
      await client.query(
        `update memory_revision_publications set status='selected'
        where source_kind=$1 and owner_id=$2 and tree_digest=$3 and trajectory_digest=$4`,
        revisionPublicationIdentity(input),
      )
      const replay = await client.query<{
        revision: string
        identical: boolean
      }>(
        `select revision.revision,
                revision.predecessor_revision is not distinct from nullif($2, 0) and
                revision.memory_tree_reference=$3::jsonb and
                ($4::text='maintenance' and
                  revision.maintenance_trajectory_reference=$5::jsonb and
                  coalesce(array_agg(observation.extraction_id order by observation.extraction_id)
                    filter (where observation.extraction_id is not null), '{}')=$6::text[] or
                 $4::text='operator' and revision.actor=$7::jsonb)
                  as identical
         from memory_tree_revisions revision
         left join observations observation
           on observation.consumed_revision=revision.revision
         where ($4::text='maintenance' and revision.maintenance_id=$1) or
               ($4::text='operator' and revision.operation_id=$1)
         group by revision.revision`,
        [
          source.kind === 'maintenance'
            ? source.maintenance_id
            : source.operation_id,
          input.expected_active_revision,
          JSON.stringify(input.memory_tree_reference),
          source.kind,
          source.kind === 'maintenance'
            ? JSON.stringify(source.trajectory_reference)
            : null,
          source.kind === 'maintenance'
            ? [...source.extraction_ids].sort()
            : [],
          source.kind === 'operator' ? JSON.stringify(source.actor) : null,
        ],
      )
      const existing = replay.rows[0]
      if (existing !== undefined) {
        if (!existing.identical) {
          throw new MemoryTreeRevisionConflictError(
            `${source.kind === 'maintenance' ? 'Maintenance id' : 'Operation id'} already exists with different content.`,
          )
        }
        return {
          created: false,
          revision: Number(existing.revision),
          source:
            source.kind === 'maintenance'
              ? { kind: 'maintenance', maintenance_id: source.maintenance_id }
              : { kind: 'operator', operation_id: source.operation_id },
        }
      }

      if (source.kind === 'maintenance') {
        const control = await client.query<{ state: 'enabled' | 'paused' }>(
          `select state from maintenance_control
           where singleton=true for update`,
        )
        if (control.rows[0]?.state !== 'enabled')
          throw new MaintenancePausedError(
            'Automatic memory maintenance is paused.',
          )
      }

      const active = await client.query<{ revision: string }>(
        `select active_revision as revision from memory_tree_state
         where singleton=true for update`,
      )
      if (Number(active.rows[0]?.revision) !== input.expected_active_revision) {
        throw new MemoryTreeRevisionConflictError(
          `Active revision no longer matches expected active revision ${input.expected_active_revision}.`,
        )
      }
      if (source.kind === 'maintenance') {
        const selected = await client.query<{ extraction_id: string }>(
          `select extraction_id from observations
           where extraction_id=any($1) and consumed_revision is null for update`,
          [source.extraction_ids],
        )
        if (
          selected.rowCount !== source.extraction_ids.length ||
          !source.extraction_ids.every((id) =>
            selected.rows.some((row) => row.extraction_id === id),
          )
        ) {
          throw new MemoryTreeRevisionConflictError(
            'One or more source observations are no longer pending.',
          )
        }
      }
      const next = await client.query<{ revision: string }>(
        `select coalesce(max(revision), 0) + 1 as revision
         from memory_tree_revisions`,
      )
      const nextRevision = Number(next.rows[0]?.revision)
      await client.query(
        `insert into memory_tree_revisions (
           revision, predecessor_revision, memory_tree_reference, source_kind,
           maintenance_id, maintenance_trajectory_reference,
           operation_id, actor
         ) values ($1,nullif($2, 0),$3,$4,$5,$6,$7,$8)`,
        [
          nextRevision,
          input.expected_active_revision,
          input.memory_tree_reference,
          source.kind,
          source.kind === 'maintenance' ? source.maintenance_id : null,
          source.kind === 'maintenance' ? source.trajectory_reference : null,
          source.kind === 'operator' ? source.operation_id : null,
          source.kind === 'operator' ? source.actor : null,
        ],
      )
      if (source.kind === 'maintenance')
        await client.query(
          `update observations set consumed_revision=$1
           where extraction_id=any($2) and consumed_revision is null`,
          [nextRevision, source.extraction_ids],
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
        source:
          source.kind === 'maintenance'
            ? { kind: 'maintenance', maintenance_id: source.maintenance_id }
            : { kind: 'operator', operation_id: source.operation_id },
      }
    })
  }

  async restoreMemoryTree(
    input: AuthenticatedMemoryTreeRestoreOperation,
  ): Promise<MemoryTreeRestoreOperationResult> {
    return await inTransaction(this.#pool, async (client) => {
      const replay = await client.query<{
        identical: boolean
        restored_revision: string
      }>(
        `select expected_active_revision=$2 and restored_revision=$3 and
                actor=$4::jsonb as identical,
                restored_revision
         from memory_tree_restore_operations where operation_id=$1`,
        [
          input.operation_id,
          input.expected_active_revision,
          input.restored_revision,
          JSON.stringify(input.actor),
        ],
      )
      const existing = replay.rows[0]
      if (existing !== undefined) {
        if (!existing.identical)
          throw new MemoryTreeRevisionConflictError(
            'Restore operation id already exists with different content.',
          )
        return {
          created: false,
          active_revision: Number(existing.restored_revision),
          operation_id: input.operation_id,
        }
      }

      const active = await client.query<{ revision: string }>(
        `select active_revision as revision from memory_tree_state
         where singleton=true for update`,
      )
      if (Number(active.rows[0]?.revision) !== input.expected_active_revision)
        throw new MemoryTreeRevisionConflictError(
          `Active revision no longer matches expected active revision ${input.expected_active_revision}.`,
        )

      const target = await client.query(
        `select 1 from memory_tree_revisions where revision=$1`,
        [input.restored_revision],
      )
      if (target.rowCount === 0)
        throw new MemoryTreeRevisionConflictError(
          `Restored revision does not exist: ${input.restored_revision}.`,
        )

      await client.query(
        `insert into memory_tree_restore_operations (
           operation_id, expected_active_revision, restored_revision, actor
         ) values ($1,$2,$3,$4)`,
        [
          input.operation_id,
          input.expected_active_revision,
          input.restored_revision,
          input.actor,
        ],
      )
      await client.query(
        `update memory_tree_state
         set active_revision=$1, updated_at=clock_timestamp()
         where singleton=true`,
        [input.restored_revision],
      )
      return {
        created: true,
        active_revision: input.restored_revision,
        operation_id: input.operation_id,
      }
    })
  }
}

function revisionPublicationIdentity(
  input: AuthenticatedMemoryTreeRevisionCreation,
): string[] {
  return [
    input.source.kind,
    input.source.kind === 'maintenance'
      ? input.source.maintenance_id
      : input.source.operation_id,
    input.memory_tree_reference.digest,
    input.source.kind === 'maintenance'
      ? input.source.trajectory_reference.digest
      : '',
  ]
}

function projectRevisionPublication(row: {
  intent: AuthenticatedMemoryTreeRevisionCreation
  status: RevisionPublication['status']
}): RevisionPublication {
  const { source, ...rest } = row.intent
  return {
    status: row.status,
    intent: {
      ...rest,
      source:
        source.kind === 'operator'
          ? { kind: source.kind, operation_id: source.operation_id }
          : source,
    },
  }
}
