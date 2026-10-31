import type { Pool } from 'pg'

import type {
  Actor,
  ArtifactReference,
  CatalogOverview,
  ExtractionList,
  ExtractionRecord,
  MaintenanceControl,
  MemoryTree,
  MemoryTreeRevision,
  MemoryTreeRevisionList,
  ObservationBacklog,
  ObservationList,
} from './contract-types-generated.js'

type CatalogOverviewRange = '30d' | '90d' | 'all'

export interface ExtractionListFilters {
  sourceWorkflow?: string
  sourceRunId?: string
  hasObservation?: boolean
}

export interface ObservationListFilters {
  status?: 'pending' | 'consumed'
  consumedRevision?: number
}

export interface MemoryCatalogQueries {
  getExtraction(extractionId: string): Promise<ExtractionRecord | undefined>
  listExtractions(
    cursor: string | undefined,
    limit: number,
    filters: ExtractionListFilters,
  ): Promise<ExtractionList>
  listObservations(
    cursor: string | undefined,
    limit: number,
    filters: ObservationListFilters,
  ): Promise<ObservationList>
  getObservationBacklog(): Promise<ObservationBacklog>
  getCatalogOverview(range: CatalogOverviewRange): Promise<CatalogOverview>
  getMaintenanceControl(): Promise<MaintenanceControl>
  getMemoryTree(): Promise<MemoryTree>
  getMemoryTreeRevision(
    revision: number,
  ): Promise<MemoryTreeRevision | undefined>
  listMemoryTreeRevisions(
    beforeRevision: number | undefined,
    limit: number,
  ): Promise<MemoryTreeRevisionList>
}

export class InvalidCatalogCursorError extends Error {
  readonly statusCode = 400
}

interface CatalogCursor {
  createdAt: string
  extractionId: string
}

interface RevisionRow {
  revision: string
  predecessor_revision: string | null
  source_kind: 'maintenance' | 'operator'
  maintenance_id: string | null
  extraction_ids: string[]
  maintenance_trajectory_reference: ArtifactReference | null
  operation_id: string | null
  actor: Actor | null
  memory_tree_reference: ArtifactReference
  created_at: Date
}

function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string | undefined): CatalogCursor | undefined {
  if (value === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    )
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Object.keys(decoded).length !== 2 ||
      !('createdAt' in decoded) ||
      typeof decoded.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      !('extractionId' in decoded) ||
      typeof decoded.extractionId !== 'string' ||
      decoded.extractionId.length === 0
    ) {
      throw new Error('invalid shape')
    }
    return {
      createdAt: decoded.createdAt,
      extractionId: decoded.extractionId,
    }
  } catch {
    throw new InvalidCatalogCursorError('Invalid catalog pagination cursor.')
  }
}

/** Read-only catalog views, cursor pagination, and database-to-contract projections. */
export class PostgresMemoryCatalogQueries implements MemoryCatalogQueries {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async getExtraction(
    extractionId: string,
  ): Promise<ExtractionRecord | undefined> {
    const result = await this.pool.query<{
      extraction_id: string
      source_workflow: string
      source_run_id: string
      source_unit_id: string
      diagnostic_bundle_digest: string
      trajectory_reference: ArtifactReference
      body_markdown: string | null
      created_at: Date
    }>(
      `select extraction.extraction_id, extraction.source_workflow,
              extraction.source_run_id, extraction.source_unit_id,
              extraction.diagnostic_bundle_digest, extraction.trajectory_reference,
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
          source_unit_id: row.source_unit_id,
          diagnostic_bundle_digest: row.diagnostic_bundle_digest,
          trajectory_reference: row.trajectory_reference,
          observation:
            row.body_markdown === null
              ? null
              : { body_markdown: row.body_markdown },
          created_at: row.created_at.toISOString(),
        }
      : undefined
  }

  async listExtractions(
    cursorValue: string | undefined,
    limit: number,
    filters: ExtractionListFilters,
  ): Promise<ExtractionList> {
    const cursor = decodeCursor(cursorValue)
    const result = await this.pool.query<{
      extraction_id: string
      source_workflow: string
      source_run_id: string
      source_unit_id: string
      diagnostic_bundle_digest: string
      trajectory_reference: ArtifactReference
      body_markdown: string | null
      created_at: Date
    }>(
      `select extraction.extraction_id, extraction.source_workflow,
              extraction.source_run_id, extraction.source_unit_id,
              extraction.diagnostic_bundle_digest, extraction.trajectory_reference,
              observation.body_markdown, extraction.created_at
       from extractions extraction
       left join observations observation using (extraction_id)
       where ($1::timestamptz is null or
                (extraction.created_at, extraction.extraction_id) < ($1, $2))
         and ($3::text is null or extraction.source_workflow=$3)
         and ($4::text is null or extraction.source_run_id=$4)
         and ($5::boolean is null or (observation.extraction_id is not null)=$5)
       order by extraction.created_at desc, extraction.extraction_id desc
       limit $6`,
      [
        cursor?.createdAt ?? null,
        cursor?.extractionId ?? null,
        filters.sourceWorkflow ?? null,
        filters.sourceRunId ?? null,
        filters.hasObservation ?? null,
        limit + 1,
      ],
    )
    const rows = result.rows.slice(0, limit)
    return {
      extractions: rows.map(projectExtraction),
      next_cursor:
        result.rows.length > limit && rows.length > 0
          ? encodeCursor({
              createdAt: rows[rows.length - 1]!.created_at.toISOString(),
              extractionId: rows[rows.length - 1]!.extraction_id,
            })
          : null,
    }
  }

  async listObservations(
    cursorValue: string | undefined,
    limit: number,
    filters: ObservationListFilters,
  ): Promise<ObservationList> {
    const cursor = decodeCursor(cursorValue)
    const result = await this.pool.query<{
      extraction_id: string
      source_run_id: string
      source_unit_id: string
      body_markdown: string
      consumed_revision: string | null
      created_at: Date
    }>(
      `select observation.extraction_id, extraction.source_run_id,
              extraction.source_unit_id,
              observation.body_markdown,
              observation.consumed_revision, observation.created_at
       from observations observation
       join extractions extraction using (extraction_id)
       where ($1::timestamptz is null or
                (observation.created_at, observation.extraction_id) < ($1, $2))
         and ($3::text is null or
              ($3='pending' and observation.consumed_revision is null) or
              ($3='consumed' and observation.consumed_revision is not null))
         and ($4::bigint is null or observation.consumed_revision=$4)
       order by observation.created_at desc, observation.extraction_id desc
       limit $5`,
      [
        cursor?.createdAt ?? null,
        cursor?.extractionId ?? null,
        filters.status ?? null,
        filters.consumedRevision ?? null,
        limit + 1,
      ],
    )
    const rows = result.rows.slice(0, limit)
    return {
      observations: rows.map((row) => ({
        extraction_id: row.extraction_id,
        source_run_id: row.source_run_id,
        source_unit_id: row.source_unit_id,
        body_markdown: row.body_markdown,
        consumed_revision:
          row.consumed_revision === null ? null : Number(row.consumed_revision),
        created_at: row.created_at.toISOString(),
      })),
      next_cursor:
        result.rows.length > limit && rows.length > 0
          ? encodeCursor({
              createdAt: rows[rows.length - 1]!.created_at.toISOString(),
              extractionId: rows[rows.length - 1]!.extraction_id,
            })
          : null,
    }
  }

  async getObservationBacklog(): Promise<ObservationBacklog> {
    const result = await this.pool.query<{
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

  async getCatalogOverview(
    range: CatalogOverviewRange,
  ): Promise<CatalogOverview> {
    const boundedTrend = `with bounds as (
             select (current_timestamp at time zone 'UTC')::date as current_period
           ), periods as (
             select generate_series(
               bounds.current_period - ($1::integer * interval '1 day'),
               bounds.current_period, interval '1 day'
             )::date as period
             from bounds
           ), unit_outcomes as (
             select (extraction.created_at at time zone 'UTC')::date as period,
                    extraction.source_run_id, extraction.source_unit_id,
                    bool_or(observation.extraction_id is not null) as has_observation
             from extractions extraction
             left join observations observation using (extraction_id)
             cross join bounds
             where extraction.created_at >=
                   (bounds.current_period::timestamp at time zone 'UTC') -
                   ($1::integer * interval '1 day')
             group by (extraction.created_at at time zone 'UTC')::date,
                      extraction.source_run_id, extraction.source_unit_id
           )
           select periods.period::text as period_start,
                  count(unit_outcomes.source_unit_id) as extracted_unit_count,
                  count(unit_outcomes.source_unit_id)
                    filter (where unit_outcomes.has_observation)
                    as units_with_observation_count
           from periods
           left join unit_outcomes on unit_outcomes.period=periods.period
           group by periods.period order by periods.period`
    const allTimeTrend = `with bounds as (
             select coalesce(
                      date_trunc('month', min(created_at) at time zone 'UTC'),
                      date_trunc('month', current_timestamp at time zone 'UTC')
                    )::date as first_period,
                    date_trunc(
                      'month', current_timestamp at time zone 'UTC'
                    )::date as current_period
             from extractions
           ), periods as (
             select generate_series(
               bounds.first_period, bounds.current_period, interval '1 month'
             )::date as period
             from bounds
           ), unit_outcomes as (
             select date_trunc(
                      'month', extraction.created_at at time zone 'UTC'
                    )::date as period,
                    extraction.source_run_id, extraction.source_unit_id,
                    bool_or(observation.extraction_id is not null) as has_observation
             from extractions extraction
             left join observations observation using (extraction_id)
             group by date_trunc(
                        'month', extraction.created_at at time zone 'UTC'
                      )::date,
                      extraction.source_run_id, extraction.source_unit_id
           )
           select periods.period::text as period_start,
                  count(unit_outcomes.source_unit_id) as extracted_unit_count,
                  count(unit_outcomes.source_unit_id)
                    filter (where unit_outcomes.has_observation)
                    as units_with_observation_count
           from periods
           left join unit_outcomes on unit_outcomes.period=periods.period
           group by periods.period order by periods.period`
    const [totalsResult, trendResult, workflowsResult] = await Promise.all([
      this.pool.query<{
        completed_extraction_count: string
        extracted_unit_count: string
        units_with_observation_count: string
        units_without_observation_count: string
        observation_count: string
        pending_observation_count: string
        consumed_observation_count: string
      }>(`with unit_outcomes as (
             select extraction.source_run_id, extraction.source_unit_id,
                    bool_or(observation.extraction_id is not null) as has_observation
             from extractions extraction
             left join observations observation using (extraction_id)
             group by extraction.source_run_id, extraction.source_unit_id
           )
           select (select count(*) from extractions) as completed_extraction_count,
                  count(*) as extracted_unit_count,
                  count(*) filter (where has_observation) as units_with_observation_count,
                  count(*) filter (where not has_observation) as units_without_observation_count,
                  (select count(*) from observations) as observation_count,
                  (select count(*) from observations where consumed_revision is null)
                    as pending_observation_count,
                  (select count(*) from observations where consumed_revision is not null)
                    as consumed_observation_count
           from unit_outcomes`),
      this.pool.query<{
        period_start: string
        extracted_unit_count: string
        units_with_observation_count: string
      }>(
        range === 'all' ? allTimeTrend : boundedTrend,
        range === 'all' ? [] : [range === '30d' ? 29 : 89],
      ),
      this.pool.query<{
        source_workflow: string
        extracted_unit_count: string
        units_with_observation_count: string
        units_without_observation_count: string
      }>(`with unit_outcomes as (
             select extraction.source_workflow, extraction.source_run_id,
                    extraction.source_unit_id,
                    bool_or(observation.extraction_id is not null) as has_observation
             from extractions extraction
             left join observations observation using (extraction_id)
             group by extraction.source_workflow, extraction.source_run_id,
                      extraction.source_unit_id
           )
           select source_workflow,
                  count(*) as extracted_unit_count,
                  count(*) filter (where has_observation)
                    as units_with_observation_count,
                  count(*) filter (where not has_observation)
                    as units_without_observation_count
           from unit_outcomes group by source_workflow
           order by extracted_unit_count desc, source_workflow`),
    ])
    const totals = totalsResult.rows[0]
    if (totals === undefined)
      throw new Error('Catalog overview totals query returned no row.')
    return {
      totals: {
        completed_extraction_count: Number(totals.completed_extraction_count),
        extracted_unit_count: Number(totals.extracted_unit_count),
        units_with_observation_count: Number(
          totals.units_with_observation_count,
        ),
        units_without_observation_count: Number(
          totals.units_without_observation_count,
        ),
        observation_count: Number(totals.observation_count),
        pending_observation_count: Number(totals.pending_observation_count),
        consumed_observation_count: Number(totals.consumed_observation_count),
      },
      trend_granularity: range === 'all' ? 'month' : 'day',
      trend_points: trendResult.rows.map((row) => ({
        period_start: row.period_start,
        extracted_unit_count: Number(row.extracted_unit_count),
        units_with_observation_count: Number(row.units_with_observation_count),
      })),
      workflows: workflowsResult.rows.map((row) => ({
        source_workflow: row.source_workflow,
        extracted_unit_count: Number(row.extracted_unit_count),
        units_with_observation_count: Number(row.units_with_observation_count),
        units_without_observation_count: Number(
          row.units_without_observation_count,
        ),
      })),
    }
  }

  async getMaintenanceControl(): Promise<MaintenanceControl> {
    const result = await this.pool.query<{
      state: 'enabled' | 'paused'
      generation: string
      changed_by: Actor
      changed_at: Date
    }>(`select state, generation, changed_by, changed_at
        from maintenance_control where singleton=true`)
    const row = result.rows[0]
    if (row === undefined)
      throw new Error('Maintenance control row is missing.')
    return {
      state: row.state,
      generation: Number(row.generation),
      changed_by: row.changed_by,
      changed_at: row.changed_at.toISOString(),
    }
  }

  async getMemoryTree(): Promise<MemoryTree> {
    const result = await this.pool.query<{
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
    const result = await this.pool.query<RevisionRow>(
      `select revision.revision, revision.predecessor_revision, revision.source_kind,
              revision.maintenance_id, revision.maintenance_trajectory_reference,
              revision.operation_id, revision.actor,
              coalesce(array_agg(observation.extraction_id order by observation.extraction_id)
                filter (where observation.extraction_id is not null), '{}') as extraction_ids,
              revision.memory_tree_reference, revision.created_at
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
    const result = await this.pool.query<RevisionRow>(
      `select revision.revision, revision.predecessor_revision, revision.source_kind,
              revision.maintenance_id, revision.maintenance_trajectory_reference,
              revision.operation_id, revision.actor,
              coalesce(array_agg(observation.extraction_id order by observation.extraction_id)
                filter (where observation.extraction_id is not null), '{}') as extraction_ids,
              revision.memory_tree_reference, revision.created_at
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

function projectExtraction(row: {
  extraction_id: string
  source_workflow: string
  source_run_id: string
  source_unit_id: string
  diagnostic_bundle_digest: string
  trajectory_reference: ArtifactReference
  body_markdown: string | null
  created_at: Date
}): ExtractionRecord {
  return {
    extraction_id: row.extraction_id,
    source_workflow: row.source_workflow,
    source_run_id: row.source_run_id,
    source_unit_id: row.source_unit_id,
    diagnostic_bundle_digest: row.diagnostic_bundle_digest,
    trajectory_reference: row.trajectory_reference,
    observation:
      row.body_markdown === null ? null : { body_markdown: row.body_markdown },
    created_at: row.created_at.toISOString(),
  }
}

function projectRevision(row: RevisionRow): MemoryTreeRevision {
  const source =
    row.source_kind === 'maintenance'
      ? {
          kind: 'maintenance' as const,
          maintenance_id: requireValue(row.maintenance_id, 'maintenance_id'),
          extraction_ids: row.extraction_ids,
          trajectory_reference: requireValue(
            row.maintenance_trajectory_reference,
            'maintenance_trajectory_reference',
          ),
        }
      : {
          kind: 'operator' as const,
          operation_id: requireValue(row.operation_id, 'operation_id'),
          actor: requireValue(row.actor, 'actor'),
        }
  return {
    revision: Number(row.revision),
    predecessor_revision:
      row.predecessor_revision === null
        ? null
        : Number(row.predecessor_revision),
    memory_tree_reference: row.memory_tree_reference,
    source,
    created_at: row.created_at.toISOString(),
  }
}

function requireValue<T>(value: T | null, field: string): T {
  if (value === null)
    throw new Error(`Memory revision is missing source field: ${field}.`)
  return value
}
