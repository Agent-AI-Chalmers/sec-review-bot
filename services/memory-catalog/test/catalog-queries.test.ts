import { expect, test } from 'vitest'

import type { Pool } from 'pg'

import {
  InvalidCatalogCursorError,
  PostgresMemoryCatalogQueries
} from '../src/catalog-queries.js'
import { learningReport, reorganizationReport } from './maintenance-report.js'

const artifact = {
  uri: 's3://sec-review/memory/trees/memory-tree.v1.tar.zst',
  digest: `sha256:${'a'.repeat(64)}`,
  media_type: 'application/tar+zstd',
  size_bytes: 42
}

const versionTrajectory = {
  uri: 's3://sec-review/memory/trajectories/memory-maintainer/trajectory.v1.jsonl.zst',
  digest: `sha256:${'b'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 21
}

const extractionTrajectory = {
  uri: 's3://sec-review/memory/trajectories/memory-extractor/trajectory.v1.jsonl.zst',
  digest: `sha256:${'c'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 18
}

test('memory tree version history pagination returns an exclusive descending cursor', async () => {
  const queried: unknown[][] = []
  const pool = {
    query: (_sql: string, parameters: unknown[]) => {
      queried.push(parameters)
      return Promise.resolve({
        rows: [
          {
            version: '4',
            source_kind: 'learning',
            operation_id: 'maintenance-4',
            predecessor_version: '3',
            observation_ids: ['extraction-4'],
            memory_tree_reference: artifact,
            trajectory_reference: versionTrajectory,
            maintenance_report: learningReport(['extraction-4']),
            actor: null,
            created_at: new Date('2026-10-23T04:00:00Z')
          },
          {
            version: '3',
            source_kind: 'learning',
            operation_id: 'maintenance-3',
            predecessor_version: '2',
            observation_ids: ['extraction-3'],
            memory_tree_reference: artifact,
            trajectory_reference: versionTrajectory,
            maintenance_report: learningReport(['extraction-3']),
            actor: null,
            created_at: new Date('2026-10-23T03:00:00Z')
          },
          {
            version: '2',
            source_kind: 'learning',
            operation_id: 'maintenance-2',
            predecessor_version: '1',
            observation_ids: ['extraction-2'],
            memory_tree_reference: artifact,
            trajectory_reference: versionTrajectory,
            maintenance_report: learningReport(['extraction-2']),
            actor: null,
            created_at: new Date('2026-10-23T02:00:00Z')
          }
        ],
        rowCount: 3
      })
    },
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const page = await queries.listMemoryTreeVersions(5, 2)

  expect(queried).toStrictEqual([[5, 3]])
  expect(page.versions.map((entry) => entry.version)).toStrictEqual([4, 3])
  expect(page.next_before_version).toBe(3)
})

test('extraction pagination uses a stable opaque exclusive cursor', async () => {
  const parametersSeen: unknown[][] = []
  const rows = [
    {
      extraction_id: 'extraction-3',
      source_workflow: 'issue-review',
      source_run_id: 'run-3',
      source_unit_id: 'review',
      execution_archive_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: extractionTrajectory,
      body_markdown: 'Third.',
      created_at: new Date('2026-10-23T03:00:00Z')
    },
    {
      extraction_id: 'extraction-2',
      source_workflow: 'issue-review',
      source_run_id: 'run-2',
      source_unit_id: 'review',
      execution_archive_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: extractionTrajectory,
      body_markdown: null,
      created_at: new Date('2026-10-23T02:00:00Z')
    }
  ]
  const pool = {
    query: (_sql: string, parameters: unknown[]) => {
      parametersSeen.push(parameters)
      return Promise.resolve({ rows, rowCount: rows.length })
    },
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const page = await queries.listExtractions(undefined, 1, {
    sourceWorkflow: 'issue-review',
    hasObservation: true
  })

  expect(parametersSeen).toStrictEqual([
    [null, null, 'issue-review', null, true, 2]
  ])
  expect(page.extractions.map((entry) => entry.extraction_id)).toStrictEqual([
    'extraction-3'
  ])
  expect(typeof page.next_cursor).toBe('string')
  expect(page.next_cursor ?? '').toMatch(/^[A-Za-z0-9_-]+$/)
})

test('observation pagination rejects malformed cursors before querying', async () => {
  let queried = false
  const pool = {
    query: () => {
      queried = true
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  await expect(queries.listObservations('not-json', 10, {})).rejects.toThrow(
    InvalidCatalogCursorError
  )
  expect(queried).toBe(false)
})

test('observation records include their authoritative extraction source', async () => {
  const pool = {
    query: () =>
      Promise.resolve({
        rows: [
          {
            extraction_id: 'extraction-1',
            observation_id: 'extraction-1',
            source_run_id: 'run-1',
            source_unit_id: 'review',
            body_markdown: 'Remember this.',
            consumed_version: null,
            created_at: new Date('2026-10-23T00:00:00Z')
          }
        ],
        rowCount: 1
      }),
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const page = await queries.listObservations(undefined, 10, {})

  expect(page.observations).toStrictEqual([
    {
      extraction_id: 'extraction-1',
      observation_id: 'extraction-1',
      source_run_id: 'run-1',
      source_unit_id: 'review',
      body_markdown: 'Remember this.',
      consumed_version: null,
      created_at: '2026-10-23T00:00:00.000Z'
    }
  ])
})

test('catalog overview projects completed extraction outcomes by distinct unit', async () => {
  let trendQuery: { sql: string; values: unknown[] | undefined } | undefined
  const pool = {
    query: (sql: string, values?: unknown[]) => {
      if (sql.includes('completed_extraction_count'))
        return Promise.resolve({
          rows: [
            {
              completed_extraction_count: '5',
              extracted_unit_count: '4',
              units_with_observation_count: '3',
              units_without_observation_count: '1',
              observation_count: '3',
              pending_observation_count: '2',
              consumed_observation_count: '1'
            }
          ],
          rowCount: 1
        })
      if (sql.includes('generate_series')) {
        trendQuery = { sql, values }
        return Promise.resolve({
          rows: [
            {
              period_start: '2026-10-23',
              extracted_unit_count: '4',
              units_with_observation_count: '3'
            }
          ],
          rowCount: 1
        })
      }
      return Promise.resolve({
        rows: [
          {
            source_workflow: 'issue-review',
            extracted_unit_count: '4',
            units_with_observation_count: '3',
            units_without_observation_count: '1'
          }
        ],
        rowCount: 1
      })
    },
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  expect(await queries.getCatalogOverview('30d')).toStrictEqual({
    totals: {
      completed_extraction_count: 5,
      extracted_unit_count: 4,
      units_with_observation_count: 3,
      units_without_observation_count: 1,
      observation_count: 3,
      pending_observation_count: 2,
      consumed_observation_count: 1
    },
    trend_granularity: 'day',
    trend_points: [
      {
        period_start: '2026-10-23',
        extracted_unit_count: 4,
        units_with_observation_count: 3
      }
    ],
    workflows: [
      {
        source_workflow: 'issue-review',
        extracted_unit_count: 4,
        units_with_observation_count: 3,
        units_without_observation_count: 1
      }
    ]
  })
  expect(trendQuery?.values).toStrictEqual([29])
  expect(trendQuery?.sql ?? '').toMatch(/created_at at time zone 'UTC'/)
  expect(trendQuery?.sql ?? '').toMatch(/current_timestamp at time zone 'UTC'/)
})

test('all-time catalog overview uses UTC month periods including an empty current month', async () => {
  let trendQuery: { sql: string; values: unknown[] | undefined } | undefined
  const pool = {
    query: (sql: string, values?: unknown[]) => {
      if (sql.includes('completed_extraction_count'))
        return Promise.resolve({
          rows: [
            {
              completed_extraction_count: '0',
              extracted_unit_count: '0',
              units_with_observation_count: '0',
              units_without_observation_count: '0',
              observation_count: '0',
              pending_observation_count: '0',
              consumed_observation_count: '0'
            }
          ],
          rowCount: 1
        })
      if (sql.includes('generate_series')) {
        trendQuery = { sql, values }
        return Promise.resolve({
          rows: [
            {
              period_start: '2026-10-01',
              extracted_unit_count: '0',
              units_with_observation_count: '0'
            }
          ],
          rowCount: 1
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const overview = await queries.getCatalogOverview('all')

  expect(overview.trend_granularity).toBe('month')
  expect(overview.trend_points).toStrictEqual([
    {
      period_start: '2026-10-01',
      extracted_unit_count: 0,
      units_with_observation_count: 0
    }
  ])
  expect(trendQuery?.values).toStrictEqual([])
  expect(trendQuery?.sql ?? '').toMatch(/date_trunc\('month'/)
  expect(trendQuery?.sql ?? '').toMatch(/at time zone 'UTC'/)
  expect(trendQuery?.sql ?? '').toMatch(/coalesce\(/)
})

test('memory-tree automation reads the durable singleton state', async () => {
  const pool = {
    query: () =>
      Promise.resolve({
        rows: [
          {
            state: 'enabled',
            version: '0',
            changed_by: { kind: 'service', id: 'memory-catalog' },
            changed_at: new Date('2026-10-23T00:00:00Z')
          }
        ],
        rowCount: 1
      }),
    end: () => Promise.resolve()
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  expect(await queries.getMemoryTreeAutomation()).toStrictEqual({
    state: 'enabled',
    version: 0,
    changed_by: { kind: 'service', id: 'memory-catalog' },
    changed_at: '2026-10-23T00:00:00.000Z'
  })
})

test('reorganization versions retain their source and trajectory in detail and history', async () => {
  const pool = {
    query: () =>
      Promise.resolve({
        rows: [
          {
            version: '2',
            predecessor_version: '1',
            source_kind: 'reorganization',
            operation_id: 'reorganization-2',
            observation_ids: [],
            trajectory_reference: versionTrajectory,
            maintenance_report: reorganizationReport,
            actor: null,
            memory_tree_reference: artifact,
            created_at: new Date('2026-10-23T04:00:00Z')
          }
        ]
      })
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)
  const expected = {
    version: 2,
    predecessor_version: 1,
    source: {
      kind: 'reorganization',
      operation_id: 'reorganization-2',
      trajectory_reference: versionTrajectory,
      maintenance_report: reorganizationReport
    },
    memory_tree_reference: artifact,
    created_at: '2026-10-23T04:00:00.000Z'
  }
  expect(await queries.getMemoryTreeVersion(2)).toStrictEqual(expected)
  expect(await queries.listMemoryTreeVersions(undefined, 10)).toStrictEqual({
    versions: [expected],
    next_before_version: null
  })
})
