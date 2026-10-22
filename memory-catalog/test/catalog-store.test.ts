import assert from 'node:assert/strict'
import test from 'node:test'

import type { Pool } from 'pg'

import { PostgresMemoryCatalogStore } from '../src/catalog-store.js'

const artifact = {
  uri: 's3://sec-review/memory/version.tar.zst',
  digest: `sha256:${'a'.repeat(64)}`,
  media_type: 'application/tar+zstd',
  size_bytes: 42,
}

const audit = {
  uri: 's3://sec-review/memory/audit.tar.zst',
  digest: `sha256:${'b'.repeat(64)}`,
  media_type: 'application/tar+zstd',
  size_bytes: 21,
}

void test('maintenance commit records immutable history before moving the active pointer', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (sql.includes('select revision from active_revision'))
        return Promise.resolve({ rows: [{ revision: '3' }], rowCount: 1 })
      if (sql.includes('select observation_id from observations'))
        return Promise.resolve({
          rows: [{ observation_id: 'observation-1' }],
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

  assert.equal(
    await store.completeMaintenance({
      base_revision: 3,
      observation_ids: ['observation-1'],
      memory_version: artifact,
      audit_reference: audit,
    }),
    true,
  )

  const operations = statements
    .map(({ sql }) => sql.trim())
    .filter((sql) => sql !== 'begin' && sql !== 'commit')
  assert.match(operations[0] ?? '', /active_revision/)
  assert.match(operations[1] ?? '', /observations/)
  assert.match(operations[2] ?? '', /insert into revisions/)
  assert.match(operations[3] ?? '', /set consumed_revision=/)
  assert.match(operations[4] ?? '', /update active_revision/)
  assert.deepEqual(statements[4]?.parameters, [4, ['observation-1']])
  assert.deepEqual(statements[5]?.parameters, [4])
})

void test('revision history pagination returns an exclusive descending cursor', async () => {
  const queried: unknown[][] = []
  const pool = {
    query: (_sql: string, parameters: unknown[]) => {
      queried.push(parameters)
      return Promise.resolve({
        rows: [
          {
            revision: '4',
            artifact_reference: artifact,
            maintenance_audit_reference: audit,
            created_at: new Date('2026-10-23T04:00:00Z'),
          },
          {
            revision: '3',
            artifact_reference: artifact,
            maintenance_audit_reference: audit,
            created_at: new Date('2026-10-23T03:00:00Z'),
          },
          {
            revision: '2',
            artifact_reference: artifact,
            maintenance_audit_reference: audit,
            created_at: new Date('2026-10-23T02:00:00Z'),
          },
        ],
        rowCount: 3,
      })
    },
    end: () => Promise.resolve(),
  } as unknown as Pool
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const page = await store.listRevisions(5, 2)

  assert.deepEqual(queried, [[5, 3]])
  assert.deepEqual(
    page.revisions.map((entry) => entry.revision),
    [4, 3],
  )
  assert.equal(page.next_before_revision, 3)
})
