import assert from 'node:assert/strict'
import test from 'node:test'

import type { Pool } from 'pg'

import { PostgresMemoryCatalogStore } from '../src/catalog-store.js'
import {
  ExtractionConflictError,
  InvalidCatalogCursorError,
  MaintenancePausedError,
  MemoryTreeRevisionConflictError,
} from '../src/catalog-store.js'

const artifact = {
  uri: 's3://sec-review/memory/trees/memory-tree.v1.tar.zst',
  digest: `sha256:${'a'.repeat(64)}`,
  media_type: 'application/tar+zstd',
  size_bytes: 42,
}

const maintenanceTranscript = {
  uri: 's3://sec-review/memory/transcripts/memory-maintainer/transcript.v1.jsonl.zst',
  digest: `sha256:${'b'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 21,
}

const extractionTranscript = {
  uri: 's3://sec-review/memory/transcripts/memory-extractor/transcript.v1.jsonl.zst',
  digest: `sha256:${'c'.repeat(64)}`,
  media_type: 'application/zstd',
  size_bytes: 18,
}

await test('extraction registration atomically stores its optional observation', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (sql.includes('insert into extractions'))
        return Promise.resolve({ rows: [], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.equal(
    await store.registerExtraction({
      extraction_id: 'extraction-1',
      source_workflow: 'issue-review',
      source_run_id: 'run-1',
      source_unit_id: 'review',
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      transcript_reference: extractionTranscript,
      observation: { body_markdown: 'Remember this.' },
    }),
    true,
  )

  const operations = statements
    .map(({ sql }) => sql.trim())
    .filter((sql) => sql !== 'begin' && sql !== 'commit')
  assert.match(operations[0] ?? '', /insert into extractions/)
  assert.match(operations[1] ?? '', /insert into observations/)
})

await test('extraction replay compares the optional observation as part of identity', async () => {
  const client = {
    query: (sql: string) => {
      if (sql.includes('insert into extractions'))
        return Promise.resolve({ rows: [], rowCount: 0 })
      if (sql.includes('as identical'))
        return Promise.resolve({ rows: [{ identical: false }], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  await assert.rejects(
    store.registerExtraction({
      extraction_id: 'extraction-1',
      source_workflow: 'issue-review',
      source_run_id: 'run-1',
      source_unit_id: 'review',
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      transcript_reference: extractionTranscript,
      observation: null,
    }),
    ExtractionConflictError,
  )
})

await test('maintenance commit records immutable history before moving the active pointer', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (
        sql.includes(
          'select active_revision as revision from memory_tree_state',
        )
      )
        return Promise.resolve({ rows: [{ revision: '3' }], rowCount: 1 })
      if (sql.includes('select state from maintenance_control'))
        return Promise.resolve({ rows: [{ state: 'enabled' }], rowCount: 1 })
      if (sql.includes('select extraction_id from observations'))
        return Promise.resolve({
          rows: [{ extraction_id: 'extraction-1' }],
          rowCount: 1,
        })
      if (sql.includes('coalesce(max(revision)'))
        return Promise.resolve({ rows: [{ revision: '4' }], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(
    await store.createMemoryTreeRevision({
      expected_active_revision: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'maintenance',
        maintenance_id: 'maintenance-1',
        extraction_ids: ['extraction-1'],
        transcript_reference: maintenanceTranscript,
      },
    }),
    {
      created: true,
      revision: 4,
      source: { kind: 'maintenance', maintenance_id: 'maintenance-1' },
    },
  )

  const operations = statements
    .map(({ sql }) => sql.trim())
    .filter((sql) => sql !== 'begin' && sql !== 'commit')
  assert.match(operations[0] ?? '', /maintenance_id/)
  assert.match(operations[1] ?? '', /maintenance_control/)
  assert.match(operations[2] ?? '', /memory_tree_state/)
  assert.match(operations[3] ?? '', /observations/)
  assert.match(operations[4] ?? '', /coalesce\(max\(revision\)/)
  assert.match(operations[5] ?? '', /insert into memory_tree_revisions/)
  assert.match(operations[6] ?? '', /set consumed_revision=/)
  assert.match(operations[7] ?? '', /update memory_tree_state/)
  assert.deepEqual(statements[7]?.parameters, [4, ['extraction-1']])
  assert.deepEqual(statements[8]?.parameters, [4])
})

await test('an identical maintenance id replays the created revision', async () => {
  const client = {
    query: (sql: string) => {
      if (sql.includes('revision.maintenance_id=$1')) {
        return Promise.resolve({
          rows: [{ revision: '4', identical: true }],
          rowCount: 1,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(
    await store.createMemoryTreeRevision({
      expected_active_revision: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'maintenance',
        maintenance_id: 'maintenance-1',
        extraction_ids: ['extraction-1'],
        transcript_reference: maintenanceTranscript,
      },
    }),
    {
      created: false,
      revision: 4,
      source: { kind: 'maintenance', maintenance_id: 'maintenance-1' },
    },
  )
})

await test('paused control rejects a new maintenance commit before active CAS', async () => {
  const statements: string[] = []
  const client = {
    query: (sql: string) => {
      statements.push(sql)
      if (sql.includes('select state from maintenance_control'))
        return Promise.resolve({ rows: [{ state: 'paused' }], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  await assert.rejects(
    store.createMemoryTreeRevision({
      expected_active_revision: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'maintenance',
        maintenance_id: 'maintenance-1',
        extraction_ids: ['extraction-1'],
        transcript_reference: maintenanceTranscript,
      },
    }),
    MaintenancePausedError,
  )
  assert.equal(
    statements.some((sql) => sql.includes('select active_revision')),
    false,
  )
})

await test('operator edit commits without consuming observations', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({
        sql,
        ...(parameters === undefined ? {} : { parameters }),
      })
      if (sql.includes('select active_revision as revision'))
        return Promise.resolve({ rows: [{ revision: '1' }], rowCount: 1 })
      if (sql.includes('coalesce(max(revision)'))
        return Promise.resolve({ rows: [{ revision: '3' }], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(
    await store.createMemoryTreeRevision({
      expected_active_revision: 1,
      memory_tree_reference: artifact,
      source: {
        kind: 'operator',
        operation_id: 'operation-1',
        actor: { kind: 'user', id: 'alice' },
      },
    }),
    {
      created: true,
      revision: 3,
      source: { kind: 'operator', operation_id: 'operation-1' },
    },
  )
  assert.equal(
    statements.some(
      ({ sql }) =>
        sql.includes('select extraction_id from observations') ||
        sql.includes('update observations set consumed_revision'),
    ),
    false,
  )
  const insert = statements.find(({ sql }) =>
    sql.includes('insert into memory_tree_revisions'),
  )
  assert.deepEqual(insert?.parameters?.slice(0, 2), [3, 1])
})

await test('operator operation id replays identical content and rejects drift', async () => {
  let identical = true
  const client = {
    query: (sql: string) => {
      if (sql.includes('revision.operation_id=$1'))
        return Promise.resolve({
          rows: [{ revision: '5', identical }],
          rowCount: 1,
        })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)
  const input = {
    expected_active_revision: 4,
    memory_tree_reference: artifact,
    source: {
      kind: 'operator' as const,
      operation_id: 'operation-1',
      actor: { kind: 'user' as const, id: 'alice' },
    },
  }

  assert.deepEqual(await store.createMemoryTreeRevision(input), {
    created: false,
    revision: 5,
    source: { kind: 'operator', operation_id: 'operation-1' },
  })
  identical = false
  await assert.rejects(
    store.createMemoryTreeRevision(input),
    MemoryTreeRevisionConflictError,
  )
})

await test('restore moves the active pointer without creating a revision', async () => {
  const statements: string[] = []
  const client = {
    query: (sql: string) => {
      statements.push(sql)
      if (sql.includes('select active_revision as revision'))
        return Promise.resolve({ rows: [{ revision: '4' }], rowCount: 1 })
      if (sql.includes('select 1 from memory_tree_revisions'))
        return Promise.resolve({ rows: [{ found: 1 }], rowCount: 1 })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
    release: () => undefined,
  }
  const pool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(
    await store.restoreMemoryTree({
      operation_id: 'restore-1',
      expected_active_revision: 4,
      restored_revision: 2,
      actor: { kind: 'user', id: 'alice' },
    }),
    { created: true, active_revision: 2, operation_id: 'restore-1' },
  )
  assert.equal(
    statements.some((sql) => sql.includes('insert into memory_tree_revisions')),
    false,
  )
})

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
            maintenance_transcript_reference: maintenanceTranscript,
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
            maintenance_transcript_reference: maintenanceTranscript,
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
            maintenance_transcript_reference: maintenanceTranscript,
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
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const page = await store.listMemoryTreeRevisions(5, 2)

  assert.deepEqual(queried, [[5, 3]])
  assert.deepEqual(
    page.revisions.map((entry) => entry.revision),
    [4, 3],
  )
  assert.equal(page.next_before_revision, 3)
})

await test('extraction pagination uses a stable opaque exclusive cursor', async () => {
  const queries: unknown[][] = []
  const rows = [
    {
      extraction_id: 'extraction-3',
      source_workflow: 'issue-review',
      source_run_id: 'run-3',
      source_unit_id: 'review',
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      transcript_reference: extractionTranscript,
      body_markdown: 'Third.',
      created_at: new Date('2026-10-23T03:00:00Z'),
    },
    {
      extraction_id: 'extraction-2',
      source_workflow: 'issue-review',
      source_run_id: 'run-2',
      source_unit_id: 'review',
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      transcript_reference: extractionTranscript,
      body_markdown: null,
      created_at: new Date('2026-10-23T02:00:00Z'),
    },
  ]
  const pool = {
    query: (_sql: string, parameters: unknown[]) => {
      queries.push(parameters)
      return Promise.resolve({ rows, rowCount: rows.length })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const page = await store.listExtractions(undefined, 1, {
    sourceWorkflow: 'issue-review',
    hasObservation: true,
  })

  assert.deepEqual(queries, [[null, null, 'issue-review', null, true, 2]])
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
  const store = new PostgresMemoryCatalogStore('unused', pool)

  await assert.rejects(
    store.listObservations('not-json', 10, {}),
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
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const page = await store.listObservations(undefined, 10, {})

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
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(await store.getCatalogOverview('30d'), {
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
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const overview = await store.getCatalogOverview('all')

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
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(await store.getMaintenanceControl(), {
    state: 'enabled',
    generation: 0,
    changed_by: { kind: 'service', id: 'memory-catalog' },
    changed_at: '2026-10-23T00:00:00.000Z',
  })
})

await test('control replay precedes generation checks and returns stored result', async () => {
  const statements: string[] = []
  const pool = {
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          statements.push(sql)
          if (sql.includes('from maintenance_control_operations'))
            return Promise.resolve({
              rows: [
                {
                  identical: true,
                  resulting_state: 'paused',
                  resulting_generation: '2',
                  actor: { kind: 'user', id: 'alice' },
                  changed_at: new Date('2026-10-23T00:00:00Z'),
                },
              ],
              rowCount: 1,
            })
          return Promise.resolve({ rows: [], rowCount: 0 })
        },
        release: () => undefined,
      }),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  assert.deepEqual(
    await store.changeMaintenanceControl('paused', {
      operation_id: 'pause-1',
      expected_generation: 1,
      actor: { kind: 'user', id: 'alice' },
    }),
    {
      created: false,
      control: {
        state: 'paused',
        generation: 2,
        changed_by: { kind: 'user', id: 'alice' },
        changed_at: '2026-10-23T00:00:00.000Z',
      },
    },
  )
  assert.equal(
    statements.some((sql) => sql.includes('from maintenance_control\n')),
    false,
  )
})

await test('new control operation locks, checks, updates, and records the transition', async () => {
  const statements: string[] = []
  const pool = {
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          statements.push(sql)
          if (sql.includes('from maintenance_control_operations'))
            return Promise.resolve({ rows: [], rowCount: 0 })
          if (sql.includes('select state, generation from maintenance_control'))
            return Promise.resolve({
              rows: [{ state: 'enabled', generation: '3' }],
              rowCount: 1,
            })
          if (sql.includes('update maintenance_control'))
            return Promise.resolve({
              rows: [
                {
                  state: 'paused',
                  generation: '4',
                  changed_by: { kind: 'user', id: 'alice' },
                  changed_at: new Date('2026-10-23T00:00:00Z'),
                },
              ],
              rowCount: 1,
            })
          return Promise.resolve({ rows: [], rowCount: 1 })
        },
        release: () => undefined,
      }),
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const result = await store.changeMaintenanceControl('paused', {
    operation_id: 'pause-1',
    expected_generation: 3,
    actor: { kind: 'user', id: 'alice' },
  })

  assert.equal(result.created, true)
  assert.match(statements[2] ?? '', /for update/)
  assert.match(statements[3] ?? '', /update maintenance_control/)
  assert.match(
    statements[4] ?? '',
    /insert into maintenance_control_operations/,
  )
})
