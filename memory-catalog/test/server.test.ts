import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MemoryCatalogStore } from '../src/catalog-store.js'
import { ExtractionConflictError } from '../src/catalog-store.js'
import { createApp } from '../src/server.js'

const revision = {
  revision: 1,
  memory_tree_reference: {
    uri: 's3://sec-review/memory/trees/1.tar.zst',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 42,
  },
  maintenance_transcript_reference: {
    uri: 's3://sec-review/memory/transcripts/memory-maintainer/transcript.v1.jsonl.zst',
    digest: `sha256:${'b'.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 21,
  },
  created_at: '2026-10-23T00:00:00.000Z',
}

const extraction = {
  extraction_id: 'extraction-1',
  source_workflow: 'issue-review',
  source_run_id: 'run-1',
  source_review_unit_id: 'review',
  diagnostic_bundle_digest: `sha256:${'b'.repeat(64)}`,
  transcript_reference: {
    uri: 's3://sec-review/memory/transcripts/memory-extractor/transcript.v1.jsonl.zst',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 42,
  },
  observation: { body_markdown: 'Remember this.' },
}

await test('the contract authenticates and validates extraction registration', async () => {
  const extractions: unknown[] = []
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: (input) => {
      extractions.push(input)
      return Promise.resolve(true)
    },
    getExtraction: () => Promise.resolve(undefined),
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeRevision: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getRevision: () => Promise.resolve(undefined),
    listRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    payload: extraction,
  })
  const invalid = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: { authorization: 'Bearer secret' },
    payload: { ...extraction, unknown: true },
  })
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: { authorization: 'Bearer secret' },
    payload: extraction,
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(registered.json(), { ok: true, created: true })
  assert.deepEqual(extractions, [extraction])
  await app.close()
})

await test('an extraction identity conflict is a declared 409', async () => {
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () =>
      Promise.reject(new ExtractionConflictError('different content')),
    getExtraction: () => Promise.resolve(undefined),
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeRevision: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getRevision: () => Promise.resolve(undefined),
    listRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: { authorization: 'Bearer secret' },
    payload: extraction,
  })

  assert.equal(response.statusCode, 409)
  const payload: unknown = response.json()
  assert.equal(
    typeof payload === 'object' && payload !== null && 'code' in payload
      ? payload.code
      : null,
    'CONFLICT',
  )
  await app.close()
})

await test('completed extractions are queryable with or without an observation', async () => {
  const records = new Map([
    ['extraction-1', { ...extraction, created_at: '2026-10-23T00:00:00.000Z' }],
    [
      'extraction-2',
      {
        ...extraction,
        extraction_id: 'extraction-2',
        observation: null,
        created_at: '2026-10-23T00:01:00.000Z',
      },
    ],
  ])
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: (extractionId) => Promise.resolve(records.get(extractionId)),
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeRevision: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getRevision: () => Promise.resolve(undefined),
    listRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const headers = { authorization: 'Bearer secret' }

  const produced = await app.inject({
    method: 'GET',
    url: '/v1/extractions/extraction-1',
    headers,
  })
  const empty = await app.inject({
    method: 'GET',
    url: '/v1/extractions/extraction-2',
    headers,
  })
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/extractions/missing',
    headers,
  })

  assert.deepEqual(produced.json(), records.get('extraction-1'))
  assert.deepEqual(empty.json(), records.get('extraction-2'))
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), {
    error: 'Memory extraction not found: missing',
    code: 'NOT_FOUND',
  })
  await app.close()
})

await test('revision history is queryable through the public contract', async () => {
  const calls: unknown[] = []
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: () => Promise.resolve(undefined),
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeRevision: () =>
      Promise.resolve({
        revision: revision.revision,
        memory_tree_reference: revision.memory_tree_reference,
      }),
    getRevision: (requested) =>
      Promise.resolve(requested === revision.revision ? revision : undefined),
    listRevisions: (beforeRevision, limit) => {
      calls.push({ beforeRevision, limit })
      return Promise.resolve({
        revisions: [revision],
        next_before_revision: null,
      })
    },
  }
  const app = await createApp({ store, token: 'secret' })
  const headers = { authorization: 'Bearer secret' }

  const one = await app.inject({
    method: 'GET',
    url: '/v1/revisions/1',
    headers,
  })
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/revisions/2',
    headers,
  })
  const page = await app.inject({
    method: 'GET',
    url: '/v1/revisions?before_revision=3&limit=10',
    headers,
  })
  const excessivePage = await app.inject({
    method: 'GET',
    url: '/v1/revisions?limit=101',
    headers,
  })

  assert.equal(one.statusCode, 200)
  assert.deepEqual(one.json(), revision)
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), {
    error: 'Memory revision not found: 2',
    code: 'NOT_FOUND',
  })
  assert.deepEqual(page.json(), {
    revisions: [revision],
    next_before_revision: null,
  })
  assert.equal(excessivePage.statusCode, 400)
  assert.deepEqual(excessivePage.json(), {
    error: 'Revision history limit must not exceed 100.',
    code: 'INVALID_BODY',
  })
  assert.deepEqual(calls, [{ beforeRevision: 3, limit: 10 }])
  await app.close()
})
