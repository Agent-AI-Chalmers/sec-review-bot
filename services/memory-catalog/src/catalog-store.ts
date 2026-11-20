import { Pool, type PoolClient } from 'pg'

import type {
  AutomaticVersionPublicationOwner,
  ExtractionPublication,
  ExtractionPublicationIntent,
  VersionPublication,
  Actor,
  ArtifactReference,
  ExtractionRegistration,
  MemoryTreeAutomationOperation,
  MemoryTreeAutomationOperationResult,
  LearningInput,
  MemoryTreeRestoreOperation,
  MemoryTreeRestoreOperationResult,
  MemoryTreeVersionCreation,
  MemoryTreeVersionCreationResult,
  ManualVersionSource
} from './contract-types.generated.js'
import { PostgresMemoryCatalogQueries, type MemoryCatalogQueries } from './catalog-queries.js'
import { applySchemaVersions } from './database/schema-version-runner.js'

export type AuthenticatedMemoryTreeAutomationOperation = MemoryTreeAutomationOperation & {
  actor: Actor
}
export type AuthenticatedMemoryTreeRestoreOperation = MemoryTreeRestoreOperation & { actor: Actor }
export type AuthenticatedMemoryTreeVersionCreation = Omit<MemoryTreeVersionCreation, 'source'> & {
  source:
    | Extract<MemoryTreeVersionCreation['source'], { kind: 'learning' }>
    | Extract<MemoryTreeVersionCreation['source'], { kind: 'reorganization' }>
    | ManualVersionSource
}

async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
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
  reserveExtractionPublication(intent: ExtractionPublicationIntent): Promise<ExtractionPublication>
  confirmExtractionPublication(intent: ExtractionPublicationIntent): Promise<ExtractionPublication>
  listExtractionPublications(extractionId: string): Promise<ExtractionPublication[]>
  reserveVersionPublication(
    intent: AuthenticatedMemoryTreeVersionCreation
  ): Promise<VersionPublication>
  confirmVersionPublication(
    intent: AuthenticatedMemoryTreeVersionCreation
  ): Promise<VersionPublication>
  listVersionPublications(
    kind: 'learning' | 'reorganization' | 'manual',
    ownerId: string
  ): Promise<VersionPublication[]>
  abandonVersionPublications(input: AutomaticVersionPublicationOwner): Promise<VersionPublication[]>
  registerExtraction(input: ExtractionRegistration): Promise<boolean>
  changeMemoryTreeAutomation(
    targetState: 'enabled' | 'paused',
    input: AuthenticatedMemoryTreeAutomationOperation
  ): Promise<MemoryTreeAutomationOperationResult>
  getLearningInput(limit: number): Promise<LearningInput | null>
  createMemoryTreeVersion(
    input: AuthenticatedMemoryTreeVersionCreation
  ): Promise<MemoryTreeVersionCreationResult>
  restoreMemoryTree(
    input: AuthenticatedMemoryTreeRestoreOperation
  ): Promise<MemoryTreeRestoreOperationResult>
}

export class ExtractionConflictError extends Error {}

export class MemoryTreeVersionConflictError extends Error {}

export class MemoryTreeAutomationConflictError extends Error {}

export class AutomationPausedError extends Error {}

export class PublicationAbandonedError extends MemoryTreeVersionConflictError {}

/** Owns the pool lifecycle, publication ledgers, and atomic catalog transitions.
 * Read-only views live in queries; learning input retains its transaction here. */
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
    intent: ExtractionPublicationIntent
  ): Promise<ExtractionPublication> {
    return await inTransaction(this.#pool, async (client) => {
      const identity = [
        intent.registration.extraction_id,
        intent.registration.trajectory_reference.digest
      ]
      await client.query(
        `insert into extraction_publications (extraction_id, digest, intent)
        values ($1,$2,$3) on conflict do nothing`,
        [...identity, intent]
      )
      const result = await client.query<ExtractionPublication & { identical: boolean }>(
        `select intent, status, intent=$3::jsonb as identical from extraction_publications
         where extraction_id=$1 and digest=$2 for update`,
        [...identity, intent]
      )
      const row = result.rows[0]!
      if (!row.identical) {
        throw new ExtractionConflictError('Extraction publication intent changed.')
      }
      return { intent: row.intent, status: row.status }
    })
  }

  async confirmExtractionPublication(
    intent: ExtractionPublicationIntent
  ): Promise<ExtractionPublication> {
    const result = await this.#pool.query<ExtractionPublication>(
      `update extraction_publications set status=case when status='selected' then status else 'present' end
       where extraction_id=$1 and digest=$2 and intent=$3::jsonb returning intent,status`,
      [intent.registration.extraction_id, intent.registration.trajectory_reference.digest, intent]
    )
    if (!result.rows[0]) {
      throw new ExtractionConflictError('Matching extraction publication reservation is required.')
    }
    return result.rows[0]
  }

  async listExtractionPublications(extractionId: string): Promise<ExtractionPublication[]> {
    const result = await this.#pool.query<ExtractionPublication>(
      `select intent,status from extraction_publications where extraction_id=$1
       order by (status='selected') desc, created_at, digest`,
      [extractionId]
    )
    return result.rows
  }

  async reserveVersionPublication(
    intent: AuthenticatedMemoryTreeVersionCreation
  ): Promise<VersionPublication> {
    return await inTransaction(this.#pool, async (client) => {
      const identity = versionPublicationIdentity(intent)
      await client.query(
        `insert into memory_version_publications
        (source_kind, operation_id, tree_digest, trajectory_digest, intent)
        values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [...identity, intent]
      )
      const result = await client.query<{
        intent: AuthenticatedMemoryTreeVersionCreation
        status: VersionPublication['status']
        identical: boolean
      }>(
        `select intent, status, intent=$5::jsonb as identical from memory_version_publications
         where source_kind=$1 and operation_id=$2 and tree_digest=$3 and trajectory_digest=$4 for update`,
        [...identity, intent]
      )
      const row = result.rows[0]!
      if (!row.identical) {
        throw new MemoryTreeVersionConflictError('Version publication intent changed.')
      }
      return projectVersionPublication(row)
    })
  }

  async confirmVersionPublication(
    intent: AuthenticatedMemoryTreeVersionCreation
  ): Promise<VersionPublication> {
    const result = await this.#pool.query<VersionPublicationRow>(
      `update memory_version_publications
       -- Both CASEs read the row before this UPDATE, so only a reserved -> present move counts.
       set status_changed_at=case when status='reserved' then clock_timestamp() else status_changed_at end,
           status=case when status in ('selected','abandoned') then status else 'present' end
       where source_kind=$1 and operation_id=$2 and tree_digest=$3 and trajectory_digest=$4 and intent=$5::jsonb
       returning intent,status`,
      [...versionPublicationIdentity(intent), intent]
    )
    if (!result.rows[0]) {
      throw new MemoryTreeVersionConflictError(
        'Matching version publication reservation is required.'
      )
    }
    return projectVersionPublication(result.rows[0])
  }

  async listVersionPublications(
    kind: 'learning' | 'reorganization' | 'manual',
    ownerId: string
  ): Promise<VersionPublication[]> {
    const result = await this.#pool.query<VersionPublicationRow>(
      `select intent,status from memory_version_publications where source_kind=$1 and operation_id=$2
       order by (status='selected') desc, created_at, tree_digest, trajectory_digest`,
      [kind, ownerId]
    )
    return result.rows.map(projectVersionPublication)
  }

  async abandonVersionPublications(
    input: AutomaticVersionPublicationOwner
  ): Promise<VersionPublication[]> {
    return await inTransaction(this.#pool, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `version:${input.operation_id}`
      ])
      const abandoned = await abandonUnselectedVersionPublications(
        client,
        versionOwner(input),
        'worker_cleanup'
      )
      return abandoned.map(projectVersionPublication)
    })
  }

  async registerExtraction(input: ExtractionRegistration): Promise<boolean> {
    return await inTransaction(this.#pool, async (client) => {
      // Serialize candidates by owner even before an authoritative extraction row exists.
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `extraction:${input.extraction_id}`
      ])
      const selected = await client.query(
        `select 1 from extraction_publications
        where extraction_id=$1 and status='selected' and intent->'registration'<>$2::jsonb`,
        [input.extraction_id, input]
      )
      if (selected.rows[0]) {
        throw new ExtractionConflictError('A different extraction publication is already selected.')
      }
      const publication = await client.query<{ digest: string }>(
        `select digest from extraction_publications where extraction_id=$1
         and intent->'registration'=$2::jsonb and status in ('present','selected') for update`,
        [input.extraction_id, input]
      )
      if (!publication.rows[0]) {
        throw new ExtractionConflictError('A confirmed extraction publication is required.')
      }
      await client.query(
        `update extraction_publications set status='selected'
        where extraction_id=$1 and digest=$2`,
        [input.extraction_id, publication.rows[0].digest]
      )
      const inserted = await client.query(
        `insert into extractions (
           extraction_id, source_workflow, source_run_id, source_unit_id,
           execution_archive_digest, trajectory_reference
         ) values ($1,$2,$3,$4,$5,$6)
         on conflict (extraction_id) do nothing`,
        [
          input.extraction_id,
          input.source_workflow,
          input.source_run_id,
          input.source_unit_id,
          input.execution_archive_digest,
          input.trajectory_reference
        ]
      )
      if (inserted.rowCount === 1) {
        for (const observation of input.observations) {
          const insertedObservation = await client.query(
            `insert into observations (observation_id, extraction_id, body_markdown)
             values ($1,$2,$3) on conflict (observation_id) do nothing`,
            [observation.observation_id, input.extraction_id, observation.body_markdown]
          )
          if (insertedObservation.rowCount !== 1) {
            throw new ExtractionConflictError(
              `Observation ID is already occupied: ${observation.observation_id}`
            )
          }
        }
        return true
      }
      const existing = await client.query<{ identical: boolean }>(
        `select source_workflow=$2 and source_run_id=$3 and
                source_unit_id=$4 and execution_archive_digest=$5 and
                trajectory_reference=$6::jsonb and
                coalesce((select jsonb_agg(jsonb_build_object('observation_id', observation_id,
                   'body_markdown', body_markdown) order by observation_id)
                   from observations where extraction_id=$1), '[]'::jsonb)=$7::jsonb as identical
         from extractions extraction
         where extraction.extraction_id=$1`,
        [
          input.extraction_id,
          input.source_workflow,
          input.source_run_id,
          input.source_unit_id,
          input.execution_archive_digest,
          JSON.stringify(input.trajectory_reference),
          JSON.stringify(
            input.observations.toSorted((a, b) => a.observation_id.localeCompare(b.observation_id))
          )
        ]
      )
      if (existing.rows[0]?.identical !== true) {
        throw new ExtractionConflictError(
          `Extraction id already exists with different content: ${input.extraction_id}`
        )
      }
      return false
    })
  }

  async changeMemoryTreeAutomation(
    targetState: 'enabled' | 'paused',
    input: AuthenticatedMemoryTreeAutomationOperation
  ): Promise<MemoryTreeAutomationOperationResult> {
    return await inTransaction(this.#pool, async (client) => {
      // Lock before looking for a replay. A retry that overlaps the first attempt would otherwise
      // miss the replay row, wait here, and then report a version conflict for an operation
      // that succeeded.
      const current = await client.query<{
        state: 'enabled' | 'paused'
        version: string
      }>(
        `select state, version from memory_tree_automation
         where singleton=true for update`
      )
      const replay = await client.query<{
        identical: boolean
        resulting_state: 'enabled' | 'paused'
        resulting_version: string
        actor: Actor
        changed_at: Date
      }>(
        `select target_state=$2 and expected_version=$3 and
                actor=$4::jsonb as identical,
                target_state as resulting_state, expected_version + 1 as resulting_version,
                actor, changed_at
         from memory_tree_automation_operations where operation_id=$1`,
        [input.operation_id, targetState, input.expected_version, JSON.stringify(input.actor)]
      )
      const existing = replay.rows[0]
      if (existing !== undefined) {
        if (!existing.identical) {
          throw new MemoryTreeAutomationConflictError(
            'Automation operation id already exists with different content.'
          )
        }
        return {
          created: false,
          automation: {
            state: existing.resulting_state,
            version: Number(existing.resulting_version),
            changed_by: existing.actor,
            changed_at: existing.changed_at.toISOString()
          }
        }
      }

      const row = current.rows[0]
      if (row === undefined) {
        throw new Error('Memory-tree automation row is missing.')
      }
      if (Number(row.version) !== input.expected_version) {
        throw new MemoryTreeAutomationConflictError(
          `Memory-tree automation version no longer matches ${input.expected_version}.`
        )
      }
      const expectedState = targetState === 'paused' ? 'enabled' : 'paused'
      if (row.state !== expectedState) {
        throw new MemoryTreeAutomationConflictError(
          `Memory-tree automation cannot transition from ${row.state} to ${targetState}.`
        )
      }
      const changed = await client.query<{
        state: 'enabled' | 'paused'
        version: string
        changed_by: Actor
        changed_at: Date
      }>(
        `update memory_tree_automation
         set state=$1, version=version+1, changed_by=$2,
             changed_at=clock_timestamp()
         where singleton=true
         returning state, version, changed_by, changed_at`,
        [targetState, input.actor]
      )
      const control = changed.rows[0]
      if (control === undefined) {
        throw new Error('Memory-tree automation update returned no row.')
      }
      await client.query(
        `insert into memory_tree_automation_operations (
           operation_id, target_state, expected_version, actor, changed_at
         ) values ($1,$2,$3,$4,$5)`,
        [input.operation_id, targetState, input.expected_version, input.actor, control.changed_at]
      )
      return {
        created: true,
        automation: {
          state: control.state,
          version: Number(control.version),
          changed_by: control.changed_by,
          changed_at: control.changed_at.toISOString()
        }
      }
    })
  }

  async getLearningInput(limit: number): Promise<LearningInput | null> {
    return await inTransaction(this.#pool, async (client) => {
      const observations = await client.query<{
        observation_id: string
        body_markdown: string
      }>(
        `select observation_id, body_markdown
         from observations
         where consumed_version is null
         order by created_at, observation_id limit $1`,
        [limit]
      )
      if (observations.rowCount === 0) {
        return null
      }
      const active = await client.query<{
        version: string
        memory_tree_reference: ArtifactReference | null
      }>(`select state.active_version as version, version.memory_tree_reference
          from memory_tree_state state
          left join memory_tree_versions version
            on version.version=state.active_version
          where state.singleton=true`)
      const row = active.rows[0]
      if (row === undefined) {
        throw new Error('Memory tree state row is missing.')
      }
      return {
        expected_active_version: Number(row.version),
        active_memory_tree_reference: row.memory_tree_reference,
        observations: observations.rows
      }
    })
  }

  async createMemoryTreeVersion(
    input: AuthenticatedMemoryTreeVersionCreation
  ): Promise<MemoryTreeVersionCreationResult> {
    const result = await inTransaction(this.#pool, async (client) => {
      const source = input.source
      // Competing candidates must observe the winner before trying to select themselves.
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `version:${source.operation_id}`
      ])
      const selected = await client.query(
        `select 1 from memory_version_publications
        where operation_id=$1 and status='selected' and intent<>$2::jsonb`,
        [source.operation_id, input]
      )
      if (selected.rows[0]) {
        throw new MemoryTreeVersionConflictError(
          'A different version publication is already selected.'
        )
      }
      const candidate = await client.query<{
        status: VersionPublication['status']
      }>(
        'select status from memory_version_publications where source_kind=$1 and operation_id=$2 and tree_digest=$3 and trajectory_digest=$4 and intent=$5::jsonb',
        [...versionPublicationIdentity(input), input]
      )
      if (candidate.rows[0]?.status === 'abandoned') {
        throw new PublicationAbandonedError('Version publication has been abandoned.')
      }
      const publication = await client.query(
        `select 1 from memory_version_publications where source_kind=$1 and operation_id=$2
         and tree_digest=$3 and trajectory_digest=$4 and intent=$5::jsonb
         and status in ('present','selected') for update`,
        [...versionPublicationIdentity(input), input]
      )
      if (!publication.rows[0]) {
        throw new MemoryTreeVersionConflictError('A confirmed version publication is required.')
      }
      let existing: { version: string; identical: boolean } | undefined
      if (source.kind === 'learning') {
        const replay = await client.query<{
          version: string
          identical: boolean
        }>(
          `select version.version,
                  version.predecessor_version is not distinct from nullif($2, 0) and
                  version.memory_tree_reference=$3::jsonb and
                  version.trajectory_reference=$4::jsonb and
                  version.maintenance_report=$6::jsonb and
                  coalesce(array_agg(observation.observation_id order by observation.observation_id)
                    filter (where observation.observation_id is not null), '{}')=$5::text[]
                    as identical
           from memory_tree_versions version
           left join observations observation
             on observation.consumed_version=version.version
           where version.source_kind='learning' and version.operation_id=$1
           group by version.version`,
          [
            source.operation_id,
            input.expected_active_version,
            JSON.stringify(input.memory_tree_reference),
            JSON.stringify(source.trajectory_reference),
            source.observation_ids.toSorted(),
            JSON.stringify(source.maintenance_report)
          ]
        )
        existing = replay.rows[0]
      } else if (source.kind === 'reorganization') {
        const replay = await client.query<{
          version: string
          identical: boolean
        }>(
          `select version.version,
                  version.predecessor_version is not distinct from nullif($2, 0) and
                  version.memory_tree_reference=$3::jsonb and
                  version.trajectory_reference=$4::jsonb and
                  version.maintenance_report=$5::jsonb
                    as identical
           from memory_tree_versions version
           where version.source_kind='reorganization' and version.operation_id=$1`,
          [
            source.operation_id,
            input.expected_active_version,
            JSON.stringify(input.memory_tree_reference),
            JSON.stringify(source.trajectory_reference),
            JSON.stringify(source.maintenance_report)
          ]
        )
        existing = replay.rows[0]
      } else {
        const replay = await client.query<{
          version: string
          identical: boolean
        }>(
          `select version.version,
                  version.predecessor_version is not distinct from nullif($2, 0) and
                  version.memory_tree_reference=$3::jsonb and
                  version.actor=$4::jsonb as identical
           from memory_tree_versions version
           where version.source_kind='manual' and version.operation_id=$1`,
          [
            source.operation_id,
            input.expected_active_version,
            JSON.stringify(input.memory_tree_reference),
            JSON.stringify(source.actor)
          ]
        )
        existing = replay.rows[0]
      }
      if (existing !== undefined) {
        if (!existing.identical) {
          throw new MemoryTreeVersionConflictError(
            'Version operation id already exists with different content.'
          )
        }
        return {
          created: false,
          version: Number(existing.version),
          source: versionOwner(source)
        }
      }

      if (source.kind === 'learning' || source.kind === 'reorganization') {
        const control = await client.query<{ state: 'enabled' | 'paused' }>(
          `select state from memory_tree_automation
           where singleton=true for update`
        )
        if (control.rows[0]?.state !== 'enabled') {
          await abandonUnselectedVersionPublications(
            client,
            versionOwner(source),
            'automation_paused'
          )
          return null
        }
      }

      await client.query(
        `update memory_version_publications set status='selected', status_changed_at=clock_timestamp()
        where source_kind=$1 and operation_id=$2 and tree_digest=$3 and trajectory_digest=$4`,
        versionPublicationIdentity(input)
      )
      const active = await client.query<{ version: string }>(
        `select active_version as version from memory_tree_state
         where singleton=true for update`
      )
      if (Number(active.rows[0]?.version) !== input.expected_active_version) {
        throw new MemoryTreeVersionConflictError(
          `Active version no longer matches expected active version ${input.expected_active_version}.`
        )
      }
      if (source.kind === 'learning') {
        const selected = await client.query<{ observation_id: string }>(
          `select observation_id from observations
           where observation_id=any($1) and consumed_version is null for update`,
          [source.observation_ids]
        )
        if (
          selected.rowCount !== source.observation_ids.length ||
          !source.observation_ids.every((id) =>
            selected.rows.some((row) => row.observation_id === id)
          )
        ) {
          throw new MemoryTreeVersionConflictError(
            'One or more source observations are no longer pending.'
          )
        }
      }
      const next = await client.query<{ version: string }>(
        `select coalesce(max(version), 0) + 1 as version
         from memory_tree_versions`
      )
      const nextVersion = Number(next.rows[0]?.version)
      await client.query(
        `insert into memory_tree_versions (
           version, predecessor_version, memory_tree_reference, source_kind,
           operation_id, trajectory_reference, maintenance_report, actor
         ) values ($1,nullif($2, 0),$3,$4,$5,$6,$7,$8)`,
        [
          nextVersion,
          input.expected_active_version,
          input.memory_tree_reference,
          source.kind,
          source.operation_id,
          source.kind === 'manual' ? null : source.trajectory_reference,
          source.kind === 'manual' ? null : source.maintenance_report,
          source.kind === 'manual' ? source.actor : null
        ]
      )
      if (source.kind === 'learning') {
        await client.query(
          `update observations set consumed_version=$1
           where observation_id=any($2) and consumed_version is null`,
          [nextVersion, source.observation_ids]
        )
      }
      await client.query(
        `update memory_tree_state
         set active_version=$1
         where singleton=true`,
        [nextVersion]
      )
      return {
        created: true,
        version: nextVersion,
        source: versionOwner(source)
      }
    })
    // Raise after committing abandonment so a lost response cannot revive this candidate.
    if (result === null) {
      throw new AutomationPausedError('Automatic memory-tree version commits are paused.')
    }
    return result
  }

  async restoreMemoryTree(
    input: AuthenticatedMemoryTreeRestoreOperation
  ): Promise<MemoryTreeRestoreOperationResult> {
    return await inTransaction(this.#pool, async (client) => {
      // Lock before looking for a replay, for the same reason as automation changes: an overlapping
      // retry must find the first attempt's ledger row rather than an advanced active version.
      const active = await client.query<{ version: string }>(
        `select active_version as version from memory_tree_state
         where singleton=true for update`
      )
      const replay = await client.query<{
        identical: boolean
        restored_version: string
      }>(
        `select expected_active_version=$2 and restored_version=$3 and
                actor=$4::jsonb as identical,
                restored_version
         from memory_tree_restore_operations where operation_id=$1`,
        [
          input.operation_id,
          input.expected_active_version,
          input.restored_version,
          JSON.stringify(input.actor)
        ]
      )
      const existing = replay.rows[0]
      if (existing !== undefined) {
        if (!existing.identical) {
          throw new MemoryTreeVersionConflictError(
            'Restore operation id already exists with different content.'
          )
        }
        return {
          created: false,
          active_version: Number(existing.restored_version),
          operation_id: input.operation_id
        }
      }

      if (Number(active.rows[0]?.version) !== input.expected_active_version) {
        throw new MemoryTreeVersionConflictError(
          `Active version no longer matches expected active version ${input.expected_active_version}.`
        )
      }

      const target = await client.query(`select 1 from memory_tree_versions where version=$1`, [
        input.restored_version
      ])
      if (target.rowCount === 0) {
        throw new MemoryTreeVersionConflictError(
          `Restored version does not exist: ${input.restored_version}.`
        )
      }

      await client.query(
        `insert into memory_tree_restore_operations (
           operation_id, expected_active_version, restored_version, actor
         ) values ($1,$2,$3,$4)`,
        [input.operation_id, input.expected_active_version, input.restored_version, input.actor]
      )
      await client.query(
        `update memory_tree_state
         set active_version=$1
         where singleton=true`,
        [input.restored_version]
      )
      return {
        created: true,
        active_version: input.restored_version,
        operation_id: input.operation_id
      }
    })
  }
}

/** A `memory_version_publications` row as the store reads it back. */
type VersionPublicationRow = {
  intent: AuthenticatedMemoryTreeVersionCreation
  status: VersionPublication['status']
}

type VersionOwner<Kind extends string = string> = {
  kind: Kind
  operation_id: string
}

/** The `(kind, operation_id)` pair that owns a version publication, without the source's other
 * fields: a learning or reorganization source also carries its trajectory, which must not leak
 * into an owner-scoped write or a manual projection. */
function versionOwner<Kind extends string>(source: VersionOwner<Kind>): VersionOwner<Kind> {
  return { kind: source.kind, operation_id: source.operation_id }
}

/** Abandon an automatic operation's unselected version candidates. The caller holds the
 * operation's advisory lock, so a commit and an abandonment cannot both claim the same candidate.
 * Only `reserved` and `present` can be abandoned: a selected candidate is already committed, and an
 * abandoned one stays abandoned. */
async function abandonUnselectedVersionPublications(
  client: PoolClient,
  owner: VersionOwner,
  reason: 'worker_cleanup' | 'automation_paused'
): Promise<VersionPublicationRow[]> {
  const result = await client.query<VersionPublicationRow>(
    `update memory_version_publications
     set status='abandoned', abandon_reason=$3, status_changed_at=clock_timestamp()
     where source_kind=$1 and operation_id=$2 and status in ('reserved','present')
     returning intent, status`,
    [owner.kind, owner.operation_id, reason]
  )
  return result.rows
}

function versionPublicationIdentity(input: AuthenticatedMemoryTreeVersionCreation): string[] {
  return [
    input.source.kind,
    input.source.operation_id,
    input.memory_tree_reference.digest,
    input.source.kind === 'manual' ? '' : input.source.trajectory_reference.digest
  ]
}

function projectVersionPublication(row: VersionPublicationRow): VersionPublication {
  const { source, ...rest } = row.intent
  return {
    status: row.status,
    intent: {
      ...rest,
      source: source.kind === 'manual' ? versionOwner(source) : source
    }
  }
}
