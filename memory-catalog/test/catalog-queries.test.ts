import assert from 'node:assert/strict'
import test from 'node:test'

import type { Pool } from 'pg'

import {
  InvalidCatalogCursorError,
  PostgresMemoryCatalogQueries,
} from '../src/catalog-queries.js'

const artifact = {
  uri: 's3://sec-review/memory/trees/memory-tree.v1.tar.zst',
  digest: `sha256:${'a'.repeat(64)}`,
  media_type: 'application/tar+zstd',
  size_bytes: 42,
}

const maintenanceTrajectory = {
  uri: 's3://sec-review/memory/trajectories/memory-maintainer/trajectory.v1.jsonl.zst',
  digest: `sha256:${'b'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 21,
}

const extractionTrajectory = {
  uri: 's3://sec-review/memory/trajectories/memory-extractor/trajectory.v1.jsonl.zst',
  digest: `sha256:${'c'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 18,
}

await test('memory tree revision history pagination returns an exclusive descending cursor', async () => {
  const queried: unknown[][] = []
  const pool = {
    query: (_sql: string, parameters: unknown[]) => {
      queried.push(parameters)
      return Promise.resolve({
        rows: [
          {
            revision: '4',
            source_kind: 'maintenance',
            maintenance_id: 'maintenance-4',
            predecessor_revision: '3',
            extraction_ids: ['extraction-4'],
            memory_tree_reference: artifact,
            maintenance_trajectory_reference: maintenanceTrajectory,
            operation_id: null,
            actor: null,
            created_at: new Date('2026-10-23T04:00:00Z'),
          },
          {
            revision: '3',
            source_kind: 'maintenance',
            maintenance_id: 'maintenance-3',
            predecessor_revision: '2',
            extraction_ids: ['extraction-3'],
            memory_tree_reference: artifact,
            maintenance_trajectory_reference: maintenanceTrajectory,
            operation_id: null,
            actor: null,
            created_at: new Date('2026-10-23T03:00:00Z'),
          },
          {
            revision: '2',
            source_kind: 'maintenance',
            maintenance_id: 'maintenance-2',
            predecessor_revision: '1',
            extraction_ids: ['extraction-2'],
            memory_tree_reference: artifact,
            maintenance_trajectory_reference: maintenanceTrajectory,
            operation_id: null,
            actor: null,
            created_at: new Date('2026-10-23T02:00:00Z'),
          },
        ],
        rowCount: 3,
      })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const page = await queries.listMemoryTreeRevisions(5, 2)

  assert.deepEqual(queried, [[5, 3]])
  assert.deepEqual(
    page.revisions.map((entry) => entry.revision),
    [4, 3],
  )
  assert.equal(page.next_before_revision, 3)
})

await test('extraction pagination uses a stable opaque exclusive cursor', async () => {
  const parametersSeen: unknown[][] = []
  const rows = [
    {
      extraction_id: 'extraction-3',
      source_workflow: 'issue-review',
      source_run_id: 'run-3',
      source_unit_id: 'review',
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: extractionTrajectory,
      body_markdown: 'Third.',
      created_at: new Date('2026-10-23T03:00:00Z'),
    },
    {
      extraction_id: 'extraction-2',
      source_workflow: 'issue-review',
      source_run_id: 'run-2',
      source_unit_id: 'review',
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: extractionTrajectory,
      body_markdown: null,
      created_at: new Date('2026-10-23T02:00:00Z'),
    },
  ]
  const pool = {
    query: (_sql: string, parameters: unknown[]) => {
      parametersSeen.push(parameters)
      return Promise.resolve({ rows, rowCount: rows.length })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const page = await queries.listExtractions(undefined, 1, {
    sourceWorkflow: 'issue-review',
    hasObservation: true,
  })

  assert.deepEqual(parametersSeen, [
    [null, null, 'issue-review', null, true, 2],
  ])
  assert.deepEqual(
    page.extractions.map((entry) => entry.extraction_id),
    ['extraction-3'],
  )
  assert.equal(typeof page.next_cursor, 'string')
  assert.match(page.next_cursor ?? '', /^[A-Za-z0-9_-]+$/)
})

await test('observation pagination rejects malformed cursors before querying', async () => {
  let queried = false
  const pool = {
    query: () => {
      queried = true
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  await assert.rejects(
    queries.listObservations('not-json', 10, {}),
    InvalidCatalogCursorError,
  )
  assert.equal(queried, false)
})

await test('observation records include their authoritative extraction source', async () => {
  const pool = {
    query: () =>
      Promise.resolve({
        rows: [
          {
            extraction_id: 'extraction-1',
            source_run_id: 'run-1',
            source_unit_id: 'review',
            body_markdown: 'Remember this.',
            consumed_revision: null,
            created_at: new Date('2026-10-23T00:00:00Z'),
          },
        ],
        rowCount: 1,
      }),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const page = await queries.listObservations(undefined, 10, {})

  assert.deepEqual(page.observations, [
    {
      extraction_id: 'extraction-1',
      source_run_id: 'run-1',
      source_unit_id: 'review',
      body_markdown: 'Remember this.',
      consumed_revision: null,
      created_at: '2026-10-23T00:00:00.000Z',
    },
  ])
})

await test('catalog overview projects completed extraction outcomes by distinct unit', async () => {
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
              consumed_observation_count: '1',
            },
          ],
          rowCount: 1,
        })
      if (sql.includes('generate_series')) {
        trendQuery = { sql, values }
        return Promise.resolve({
          rows: [
            {
              period_start: '2026-10-23',
              extracted_unit_count: '4',
              units_with_observation_count: '3',
            },
          ],
          rowCount: 1,
        })
      }
      return Promise.resolve({
        rows: [
          {
            source_workflow: 'issue-review',
            extracted_unit_count: '4',
            units_with_observation_count: '3',
            units_without_observation_count: '1',
          },
        ],
        rowCount: 1,
      })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  assert.deepEqual(await queries.getCatalogOverview('30d'), {
    totals: {
      completed_extraction_count: 5,
      extracted_unit_count: 4,
      units_with_observation_count: 3,
      units_without_observation_count: 1,
      observation_count: 3,
      pending_observation_count: 2,
      consumed_observation_count: 1,
    },
    trend_granularity: 'day',
    trend_points: [
      {
        period_start: '2026-10-23',
        extracted_unit_count: 4,
        units_with_observation_count: 3,
      },
    ],
    workflows: [
      {
        source_workflow: 'issue-review',
        extracted_unit_count: 4,
        units_with_observation_count: 3,
        units_without_observation_count: 1,
      },
    ],
  })
  assert.deepEqual(trendQuery?.values, [29])
  assert.match(trendQuery?.sql ?? '', /created_at at time zone 'UTC'/)
  assert.match(trendQuery?.sql ?? '', /current_timestamp at time zone 'UTC'/)
})

await test('all-time catalog overview uses UTC month periods including an empty current month', async () => {
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
              consumed_observation_count: '0',
            },
          ],
          rowCount: 1,
        })
      if (sql.includes('generate_series')) {
        trendQuery = { sql, values }
        return Promise.resolve({
          rows: [
            {
              period_start: '2026-10-01',
              extracted_unit_count: '0',
              units_with_observation_count: '0',
            },
          ],
          rowCount: 1,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  const overview = await queries.getCatalogOverview('all')

  assert.equal(overview.trend_granularity, 'month')
  assert.deepEqual(overview.trend_points, [
    {
      period_start: '2026-10-01',
      extracted_unit_count: 0,
      units_with_observation_count: 0,
    },
  ])
  assert.deepEqual(trendQuery?.values, [])
  assert.match(trendQuery?.sql ?? '', /date_trunc\('month'/)
  assert.match(trendQuery?.sql ?? '', /at time zone 'UTC'/)
  assert.match(trendQuery?.sql ?? '', /coalesce\(/)
})

await test('maintenance control reads the durable singleton state', async () => {
  const pool = {
    query: () =>
      Promise.resolve({
        rows: [
          {
            state: 'enabled',
            generation: '0',
            changed_by: { kind: 'service', id: 'memory-catalog' },
            changed_at: new Date('2026-10-23T00:00:00Z'),
          },
        ],
        rowCount: 1,
      }),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const queries = new PostgresMemoryCatalogQueries(pool)

  assert.deepEqual(await queries.getMaintenanceControl(), {
    state: 'enabled',
    generation: 0,
    changed_by: { kind: 'service', id: 'memory-catalog' },
    changed_at: '2026-10-23T00:00:00.000Z',
  })
})
