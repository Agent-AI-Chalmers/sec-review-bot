import assert from 'node:assert/strict'
import test from 'node:test'

import type { Pool } from 'pg'

import { PostgresMemoryCatalogStore } from '../src/catalog-store.js'
import {
  ExtractionConflictError,
  MaintenancePausedError,
  MemoryTreeRevisionConflictError,
} from '../src/catalog-store.js'

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

await test('extraction registration atomically stores its optional observation', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select digest from extraction_publications'))
        return Promise.resolve({
          rows: [{ digest: extractionTrajectory.digest }],
          rowCount: 1,
        })
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
      trajectory_reference: extractionTrajectory,
      observation: { body_markdown: 'Remember this.' },
    }),
    true,
  )

  const operations = statements
    .map(({ sql }) => sql.trim())
    .filter(
      (sql) =>
        sql !== 'begin' &&
        sql !== 'commit' &&
        !sql.includes('extraction_publications') &&
        !sql.includes('memory_revision_publications') &&
        !sql.includes('pg_advisory_xact_lock'),
    )
  assert.match(operations[0] ?? '', /insert into extractions/)
  assert.match(operations[1] ?? '', /insert into observations/)
})

await test('extraction replay compares the optional observation as part of identity', async () => {
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select digest from extraction_publications'))
        return Promise.resolve({
          rows: [{ digest: extractionTrajectory.digest }],
          rowCount: 1,
        })
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
      trajectory_reference: extractionTrajectory,
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
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
        trajectory_reference: maintenanceTrajectory,
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
    .filter(
      (sql) =>
        sql !== 'begin' &&
        sql !== 'commit' &&
        !sql.includes('extraction_publications') &&
        !sql.includes('memory_revision_publications') &&
        !sql.includes('pg_advisory_xact_lock'),
    )
  assert.match(operations[0] ?? '', /maintenance_id/)
  assert.match(operations[1] ?? '', /maintenance_control/)
  assert.match(operations[2] ?? '', /memory_tree_state/)
  assert.match(operations[3] ?? '', /observations/)
  assert.match(operations[4] ?? '', /coalesce\(max\(revision\)/)
  assert.match(operations[5] ?? '', /insert into memory_tree_revisions/)
  assert.match(operations[6] ?? '', /set consumed_revision=/)
  assert.match(operations[7] ?? '', /update memory_tree_state/)
  assert.deepEqual(
    statements.find(({ sql }) => sql.includes('set consumed_revision='))
      ?.parameters,
    [4, ['extraction-1']],
  )
  assert.deepEqual(
    statements.find(({ sql }) => sql.includes('update memory_tree_state'))
      ?.parameters,
    [4],
  )
})

await test('an identical maintenance id replays the created revision', async () => {
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
        trajectory_reference: maintenanceTrajectory,
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
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
        trajectory_reference: maintenanceTrajectory,
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
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      statements.push(sql)
      if (
        sql.includes('select 1 from memory_revision_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
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

await test('control replay precedes generation checks and returns stored result', async () => {
  const statements: string[] = []
  const pool = {
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          if (
            sql.includes('select 1 from memory_revision_publications') &&
            sql.includes('and tree_digest=$3')
          )
            return Promise.resolve({ rows: [{}], rowCount: 1 })
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
          if (
            sql.includes('select 1 from memory_revision_publications') &&
            sql.includes('and tree_digest=$3')
          )
            return Promise.resolve({ rows: [{}], rowCount: 1 })
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
