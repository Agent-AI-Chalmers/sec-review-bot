import assert from 'node:assert/strict'
import test from 'node:test'

import type { Pool } from 'pg'

import { PostgresMemoryCatalogStore } from '../src/catalog-store.js'
import {
  ExtractionConflictError,
  AutomationPausedError,
  MemoryTreeVersionConflictError,
} from '../src/catalog-store.js'
import { learningReport, reorganizationReport } from './maintenance-report.js'

const artifact = {
  uri: 's3://sec-review/memory/trees/memory-tree.v1.tar.zst',
  digest: `sha256:${'a'.repeat(64)}`,
  media_type: 'application/tar+zstd',
  size_bytes: 42,
}

const versionTrajectory = {
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
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select digest from extraction_publications'))
        return Promise.resolve({
          rows: [{ digest: extractionTrajectory.digest }],
          rowCount: 1,
        })
      if (
        sql.includes('select 1 from memory_version_publications') &&
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
      execution_archive_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: extractionTrajectory,
      observations: [
        { observation_id: 'extraction-1', body_markdown: 'Remember this.' },
      ],
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
        !sql.includes('memory_version_publications') &&
        !sql.includes('pg_advisory_xact_lock'),
    )
  assert.match(operations[0] ?? '', /insert into extractions/)
  assert.match(operations[1] ?? '', /insert into observations/)
})

await test('extraction replay compares the optional observation as part of identity', async () => {
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select digest from extraction_publications'))
        return Promise.resolve({
          rows: [{ digest: extractionTrajectory.digest }],
          rowCount: 1,
        })
      if (
        sql.includes('select 1 from memory_version_publications') &&
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
      execution_archive_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: extractionTrajectory,
      observations: [],
    }),
    ExtractionConflictError,
  )
})

await test('learning commit records immutable history before moving the active pointer', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (
        sql.includes('select active_version as version from memory_tree_state')
      )
        return Promise.resolve({ rows: [{ version: '3' }], rowCount: 1 })
      if (sql.includes('select state from memory_tree_automation'))
        return Promise.resolve({ rows: [{ state: 'enabled' }], rowCount: 1 })
      if (sql.includes('select observation_id from observations'))
        return Promise.resolve({
          rows: [{ observation_id: 'extraction-1' }],
          rowCount: 1,
        })
      if (sql.includes('coalesce(max(version)'))
        return Promise.resolve({ rows: [{ version: '4' }], rowCount: 1 })
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
    await store.createMemoryTreeVersion({
      expected_active_version: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'learning',
        operation_id: 'maintenance-1',
        observation_ids: ['extraction-1'],
        trajectory_reference: versionTrajectory,
        maintenance_report: learningReport(['extraction-1']),
      },
    }),
    {
      created: true,
      version: 4,
      source: { kind: 'learning', operation_id: 'maintenance-1' },
    },
  )

  const operations = statements
    .map(({ sql }) => sql.trim())
    .filter(
      (sql) =>
        sql !== 'begin' &&
        sql !== 'commit' &&
        !sql.includes('extraction_publications') &&
        !sql.includes('memory_version_publications') &&
        !sql.includes('pg_advisory_xact_lock'),
    )
  assert.match(operations[0] ?? '', /operation_id/)
  assert.match(operations[1] ?? '', /memory_tree_automation/)
  assert.match(operations[2] ?? '', /memory_tree_state/)
  assert.match(operations[3] ?? '', /observations/)
  assert.match(operations[4] ?? '', /coalesce\(max\(version\)/)
  assert.match(operations[5] ?? '', /insert into memory_tree_versions/)
  assert.match(operations[6] ?? '', /set consumed_version=/)
  assert.match(operations[7] ?? '', /update memory_tree_state/)
  assert.deepEqual(
    statements.find(({ sql }) => sql.includes('set consumed_version='))
      ?.parameters,
    [4, ['extraction-1']],
  )
  assert.deepEqual(
    statements.find(({ sql }) => sql.includes('update memory_tree_state'))
      ?.parameters,
    [4],
  )
})

await test('reorganization commit records history without consuming observations', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select active_version as version'))
        return Promise.resolve({ rows: [{ version: '3' }], rowCount: 1 })
      if (sql.includes('select state from memory_tree_automation'))
        return Promise.resolve({ rows: [{ state: 'enabled' }], rowCount: 1 })
      if (sql.includes('coalesce(max(version)'))
        return Promise.resolve({ rows: [{ version: '4' }], rowCount: 1 })
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
    await store.createMemoryTreeVersion({
      expected_active_version: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'reorganization',
        operation_id: 'maintenance-1',
        trajectory_reference: versionTrajectory,
        maintenance_report: reorganizationReport,
      },
    }),
    {
      created: true,
      version: 4,
      source: { kind: 'reorganization', operation_id: 'maintenance-1' },
    },
  )
  assert.equal(
    statements.some(
      ({ sql }) =>
        sql.includes('select observation_id from observations') ||
        sql.includes('update observations set consumed_version'),
    ),
    false,
  )
  const insert = statements.find(({ sql }) =>
    sql.includes('insert into memory_tree_versions'),
  )
  assert.deepEqual(insert?.parameters, [
    4,
    3,
    artifact,
    'reorganization',
    'maintenance-1',
    versionTrajectory,
    reorganizationReport,
    null,
  ])
})

await test('an identical learning operation id replays the created version', async () => {
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('version.operation_id=$1')) {
        return Promise.resolve({
          rows: [{ version: '4', identical: true }],
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
    await store.createMemoryTreeVersion({
      expected_active_version: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'learning',
        operation_id: 'maintenance-1',
        observation_ids: ['extraction-1'],
        trajectory_reference: versionTrajectory,
        maintenance_report: learningReport(['extraction-1']),
      },
    }),
    {
      created: false,
      version: 4,
      source: { kind: 'learning', operation_id: 'maintenance-1' },
    },
  )
})

await test('paused control rejects a new automatic version commit before active CAS', async () => {
  const statements: string[] = []
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      statements.push(sql)
      if (sql.includes('select state from memory_tree_automation'))
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
    store.createMemoryTreeVersion({
      expected_active_version: 3,
      memory_tree_reference: artifact,
      source: {
        kind: 'learning',
        operation_id: 'maintenance-1',
        observation_ids: ['extraction-1'],
        trajectory_reference: versionTrajectory,
        maintenance_report: learningReport(['extraction-1']),
      },
    }),
    AutomationPausedError,
  )
  assert.equal(
    statements.some((sql) => sql.includes('select active_version')),
    false,
  )
})

await test('manual edit commits without consuming observations', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({
        sql,
        ...(parameters === undefined ? {} : { parameters }),
      })
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select active_version as version'))
        return Promise.resolve({ rows: [{ version: '1' }], rowCount: 1 })
      if (sql.includes('coalesce(max(version)'))
        return Promise.resolve({ rows: [{ version: '3' }], rowCount: 1 })
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
    await store.createMemoryTreeVersion({
      expected_active_version: 1,
      memory_tree_reference: artifact,
      source: {
        kind: 'manual',
        operation_id: 'operation-1',
        actor: { kind: 'user', id: 'alice' },
      },
    }),
    {
      created: true,
      version: 3,
      source: { kind: 'manual', operation_id: 'operation-1' },
    },
  )
  assert.equal(
    statements.some(
      ({ sql }) =>
        sql.includes('select observation_id from observations') ||
        sql.includes('update observations set consumed_version'),
    ),
    false,
  )
  const insert = statements.find(({ sql }) =>
    sql.includes('insert into memory_tree_versions'),
  )
  assert.deepEqual(insert?.parameters?.slice(0, 2), [3, 1])
})

await test('manual operation id replays identical content and rejects drift', async () => {
  let identical = true
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('version.operation_id=$1'))
        return Promise.resolve({
          rows: [{ version: '5', identical }],
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
    expected_active_version: 4,
    memory_tree_reference: artifact,
    source: {
      kind: 'manual' as const,
      operation_id: 'operation-1',
      actor: { kind: 'user' as const, id: 'alice' },
    },
  }

  assert.deepEqual(await store.createMemoryTreeVersion(input), {
    created: false,
    version: 5,
    source: { kind: 'manual', operation_id: 'operation-1' },
  })
  identical = false
  await assert.rejects(
    store.createMemoryTreeVersion(input),
    MemoryTreeVersionConflictError,
  )
})

await test('restore moves the active pointer without creating a version', async () => {
  const statements: string[] = []
  const client = {
    query: (sql: string) => {
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      statements.push(sql)
      if (
        sql.includes('select 1 from memory_version_publications') &&
        sql.includes('and tree_digest=$3')
      )
        return Promise.resolve({ rows: [{}], rowCount: 1 })
      if (sql.includes('select active_version as version'))
        return Promise.resolve({ rows: [{ version: '4' }], rowCount: 1 })
      if (sql.includes('select 1 from memory_tree_versions'))
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
      expected_active_version: 4,
      restored_version: 2,
      actor: { kind: 'user', id: 'alice' },
    }),
    { created: true, active_version: 2, operation_id: 'restore-1' },
  )
  assert.equal(
    statements.some((sql) => sql.includes('insert into memory_tree_versions')),
    false,
  )
})

/** Assert that each pattern matches a recorded statement, in this order. Statements are found by
 * what they do rather than by position, so transaction control or an unrelated read added
 * between them does not break the assertion; only a change in their relative order does. */
function assertStatementOrder(statements: string[], patterns: RegExp[]): void {
  let previous = -1
  for (const pattern of patterns) {
    const index = statements.findIndex(
      (sql, position) => position > previous && pattern.test(sql),
    )
    assert.ok(
      index > previous,
      `expected a statement matching ${pattern} after position ${previous}`,
    )
    previous = index
  }
}

await test('control replay is checked under the lock and precedes version checks', async () => {
  // The lock comes first so an overlapping retry waits for the first attempt and then finds its
  // ledger row; the version check comes after the replay so a retry is not refused for a
  // version its own first attempt advanced.
  const statements: string[] = []
  const pool = {
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          if (
            sql.includes('select 1 from memory_version_publications') &&
            sql.includes('and tree_digest=$3')
          )
            return Promise.resolve({ rows: [{}], rowCount: 1 })
          statements.push(sql)
          if (sql.includes('from memory_tree_automation_operations'))
            return Promise.resolve({
              rows: [
                {
                  identical: true,
                  resulting_state: 'paused',
                  resulting_version: '2',
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
    await store.changeMemoryTreeAutomation('paused', {
      operation_id: 'pause-1',
      expected_version: 1,
      actor: { kind: 'user', id: 'alice' },
    }),
    {
      created: false,
      automation: {
        state: 'paused',
        version: 2,
        changed_by: { kind: 'user', id: 'alice' },
        changed_at: '2026-10-23T00:00:00.000Z',
      },
    },
  )
  assertStatementOrder(statements, [
    /from memory_tree_automation\s+where singleton=true for update/,
    /from memory_tree_automation_operations/,
  ])
})

await test('new control operation locks, checks, updates, and records the transition', async () => {
  const statements: string[] = []
  const pool = {
    connect: () =>
      Promise.resolve({
        query: (sql: string) => {
          if (
            sql.includes('select 1 from memory_version_publications') &&
            sql.includes('and tree_digest=$3')
          )
            return Promise.resolve({ rows: [{}], rowCount: 1 })
          statements.push(sql)
          if (sql.includes('from memory_tree_automation_operations'))
            return Promise.resolve({ rows: [], rowCount: 0 })
          if (sql.includes('select state, version from memory_tree_automation'))
            return Promise.resolve({
              rows: [{ state: 'enabled', version: '3' }],
              rowCount: 1,
            })
          if (sql.includes('update memory_tree_automation'))
            return Promise.resolve({
              rows: [
                {
                  state: 'paused',
                  version: '4',
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

  const result = await store.changeMemoryTreeAutomation('paused', {
    operation_id: 'pause-1',
    expected_version: 3,
    actor: { kind: 'user', id: 'alice' },
  })

  assert.equal(result.created, true)
  assertStatementOrder(statements, [
    /from memory_tree_automation\s+where singleton=true for update/,
    /from memory_tree_automation_operations/,
    /update memory_tree_automation\s/,
    /insert into memory_tree_automation_operations/,
  ])
})
