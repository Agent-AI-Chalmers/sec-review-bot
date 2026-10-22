import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MemoryCatalogStore } from '../src/catalog-store.js'
import { ObservationConflictError } from '../src/catalog-store.js'
import { createApp } from '../src/server.js'

const revision = {
  revision: 1,
  artifact_reference: {
    uri: 's3://sec-review/memory/versions/1.tar.zst',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 42,
  },
  maintenance_audit_reference: {
    uri: 's3://sec-review/memory/audit/1.tar.zst',
    digest: `sha256:${'b'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 21,
  },
  created_at: '2026-10-23T00:00:00.000Z',
}

void test('the contract authenticates and validates observation registration', async () => {
  const observations: unknown[] = []
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerObservation: (input) => {
      observations.push(input)
      return Promise.resolve(true)
    },
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeVersion: () =>
      Promise.resolve({ revision: 0, artifact_reference: null }),
    getRevision: () => Promise.resolve(undefined),
    listRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const body = {
    observation_id: 'observation-1',
    source_workflow: 'issue-review',
    source_run_id: 'run-1',
    source_review_unit_id: 'review',
    transcript_digest: `sha256:${'b'.repeat(64)}`,
    body_markdown: 'Remember this.',
    audit_reference: {
      uri: 's3://sec-review/memory/audit/extraction.tar.zst',
      digest: `sha256:${'a'.repeat(64)}`,
      media_type: 'application/tar+zstd',
      size_bytes: 42,
    },
  }

  const unauthorized = await app.inject({
    method: 'POST',
    url: '/v1/observations',
    payload: body,
  })
  const invalid = await app.inject({
    method: 'POST',
    url: '/v1/observations',
    headers: { authorization: 'Bearer secret' },
    payload: { ...body, unknown: true },
  })
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/observations',
    headers: { authorization: 'Bearer secret' },
    payload: body,
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(registered.json(), { ok: true, created: true })
  assert.deepEqual(observations, [body])
  await app.close()
})

void test('an observation identity conflict is a declared 409', async () => {
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerObservation: () =>
      Promise.reject(new ObservationConflictError('different content')),
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeVersion: () =>
      Promise.resolve({ revision: 0, artifact_reference: null }),
    getRevision: () => Promise.resolve(undefined),
    listRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/observations',
    headers: { authorization: 'Bearer secret' },
    payload: {
      observation_id: 'observation-1',
      source_workflow: 'issue-review',
      source_run_id: 'run-1',
      source_review_unit_id: 'review',
      transcript_digest: `sha256:${'b'.repeat(64)}`,
      body_markdown: 'Remember this.',
      audit_reference: {
        uri: 's3://sec-review/audit.tar.zst',
        digest: `sha256:${'a'.repeat(64)}`,
        media_type: 'application/tar+zstd',
        size_bytes: 42,
      },
    },
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

void test('revision history is queryable through the public contract', async () => {
  const calls: unknown[] = []
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerObservation: () => Promise.resolve(true),
    pendingObservationSummary: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    selectMaintenanceBatch: () => Promise.resolve(null),
    completeMaintenance: () => Promise.resolve(true),
    activeVersion: () =>
      Promise.resolve({
        revision: revision.revision,
        artifact_reference: revision.artifact_reference,
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
