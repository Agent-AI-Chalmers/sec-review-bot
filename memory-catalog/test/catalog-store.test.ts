import assert from 'node:assert/strict'
import test from 'node:test'

import type { Pool } from 'pg'

import { PostgresMemoryCatalogStore } from '../src/catalog-store.js'
import { ExtractionConflictError } from '../src/catalog-store.js'

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
      source_review_unit_id: 'review',
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
      source_review_unit_id: 'review',
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
      if (sql.includes('select extraction_id from observations'))
        return Promise.resolve({
          rows: [{ extraction_id: 'extraction-1' }],
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

  assert.deepEqual(
    await store.createMemoryTreeRevision({
      maintenance_id: 'maintenance-1',
      base_revision: 3,
      extraction_ids: ['extraction-1'],
      memory_tree_reference: artifact,
      maintenance_transcript_reference: maintenanceTranscript,
    }),
    { created: true, revision: 4, maintenance_id: 'maintenance-1' },
  )

  const operations = statements
    .map(({ sql }) => sql.trim())
    .filter((sql) => sql !== 'begin' && sql !== 'commit')
  assert.match(operations[0] ?? '', /maintenance_id/)
  assert.match(operations[1] ?? '', /memory_tree_state/)
  assert.match(operations[2] ?? '', /observations/)
  assert.match(operations[3] ?? '', /insert into memory_tree_revisions/)
  assert.match(operations[4] ?? '', /set consumed_revision=/)
  assert.match(operations[5] ?? '', /update memory_tree_state/)
  assert.deepEqual(statements[5]?.parameters, [4, ['extraction-1']])
  assert.deepEqual(statements[6]?.parameters, [4])
})

await test('an identical maintenance id replays the created revision', async () => {
  const client = {
    query: (sql: string) => {
      if (sql.includes('where revision.maintenance_id=$1')) {
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
      maintenance_id: 'maintenance-1',
      base_revision: 3,
      extraction_ids: ['extraction-1'],
      memory_tree_reference: artifact,
      maintenance_transcript_reference: maintenanceTranscript,
    }),
    { created: false, revision: 4, maintenance_id: 'maintenance-1' },
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
            maintenance_id: 'maintenance-4',
            base_revision: '3',
            extraction_ids: ['extraction-4'],
            memory_tree_reference: artifact,
            maintenance_transcript_reference: maintenanceTranscript,
            created_at: new Date('2026-10-23T04:00:00Z'),
          },
          {
            revision: '3',
            maintenance_id: 'maintenance-3',
            base_revision: '2',
            extraction_ids: ['extraction-3'],
            memory_tree_reference: artifact,
            maintenance_transcript_reference: maintenanceTranscript,
            created_at: new Date('2026-10-23T03:00:00Z'),
          },
          {
            revision: '2',
            maintenance_id: 'maintenance-2',
            base_revision: '1',
            extraction_ids: ['extraction-2'],
            memory_tree_reference: artifact,
            maintenance_transcript_reference: maintenanceTranscript,
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
