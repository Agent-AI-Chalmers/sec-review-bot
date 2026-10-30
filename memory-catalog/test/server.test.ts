import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MemoryCatalogStore } from '../src/catalog-store.js'
import {
  ExtractionConflictError,
  MaintenancePausedError,
  MemoryTreeRevisionConflictError,
} from '../src/catalog-store.js'
import { createApp } from '../src/server.js'

const revision = {
  revision: 1,
  predecessor_revision: null,
  memory_tree_reference: {
    uri: 's3://sec-review/memory/trees/1.tar.zst',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 42,
  },
  source: {
    kind: 'maintenance' as const,
    maintenance_id: 'maintenance-1',
    extraction_ids: ['extraction-1'],
    trajectory_reference: {
      uri: 's3://sec-review/memory/trajectories/memory-maintainer/trajectory.v1.jsonl.zst',
      digest: `sha256:${'b'.repeat(64)}`,
      media_type: 'application/zstd',
      size_bytes: 21,
    },
  },
  created_at: '2026-10-23T00:00:00.000Z',
}

const revisionCreationResult = {
  created: true,
  revision: 1,
  source: { kind: 'maintenance' as const, maintenance_id: 'maintenance-1' },
}

const extraction = {
  extraction_id: 'extraction-1',
  source_workflow: 'issue-review',
  source_run_id: 'run-1',
  source_unit_id: 'review',
  diagnostic_bundle_digest: `sha256:${'b'.repeat(64)}`,
  trajectory_reference: {
    uri: 's3://sec-review/memory/trajectories/memory-extractor/trajectory.v1.jsonl.zst',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 42,
  },
  observation: { body_markdown: 'Remember this.' },
}

const emptyOverview = {
  totals: {
    completed_extraction_count: 0,
    extracted_unit_count: 0,
    units_with_observation_count: 0,
    units_without_observation_count: 0,
    observation_count: 0,
    pending_observation_count: 0,
    consumed_observation_count: 0,
  },
  trend_granularity: 'day' as const,
  trend_points: [],
  workflows: [],
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
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
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
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
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
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
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

await test('UI catalog reads expose paginated records and durable control state', async () => {
  const calls: unknown[] = []
  const overviewRanges: string[] = []
  const control = {
    state: 'paused' as const,
    generation: 2,
    changed_by: { kind: 'user' as const, id: 'alice' },
    changed_at: '2026-10-23T01:00:00.000Z',
  }
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: () => Promise.resolve(undefined),
    listExtractions: (cursor, limit, filters) => {
      calls.push(['extractions', cursor, limit, filters])
      return Promise.resolve({
        extractions: [
          { ...extraction, created_at: '2026-10-23T00:00:00.000Z' },
        ],
        next_cursor: 'next-extraction',
      })
    },
    listObservations: (cursor, limit, filters) => {
      calls.push(['observations', cursor, limit, filters])
      return Promise.resolve({
        observations: [
          {
            extraction_id: 'extraction-1',
            source_run_id: 'run-1',
            source_unit_id: 'review',
            body_markdown: 'Remember this.',
            consumed_revision: 1,
            created_at: '2026-10-23T00:00:00.000Z',
          },
        ],
        next_cursor: null,
      })
    },
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: (range) => {
      overviewRanges.push(range)
      return Promise.resolve({
        totals: {
          completed_extraction_count: 4,
          extracted_unit_count: 3,
          units_with_observation_count: 2,
          units_without_observation_count: 1,
          observation_count: 2,
          pending_observation_count: 1,
          consumed_observation_count: 1,
        },
        trend_granularity: 'day',
        trend_points: [
          {
            period_start: '2026-10-23',
            extracted_unit_count: 3,
            units_with_observation_count: 2,
          },
        ],
        workflows: [
          {
            source_workflow: 'issue-review',
            extracted_unit_count: 3,
            units_with_observation_count: 2,
            units_without_observation_count: 1,
          },
        ],
      })
    },
    getMaintenanceControl: () => Promise.resolve(control),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const headers = { authorization: 'Bearer secret' }

  const extractions = await app.inject({
    method: 'GET',
    url: '/v1/extractions?cursor=cursor-1&limit=10&source_workflow=issue-review&source_run_id=run-1&has_observation=true',
    headers,
  })
  const observations = await app.inject({
    method: 'GET',
    url: '/v1/observations?cursor=cursor-2&limit=20&status=consumed&consumed_revision=1',
    headers,
  })
  const maintenanceControl = await app.inject({
    method: 'GET',
    url: '/v1/maintenance-control',
    headers,
  })
  const overview = await app.inject({
    method: 'GET',
    url: '/v1/overview?range=90d',
    headers,
  })

  assert.equal(extractions.statusCode, 200)
  assert.equal(observations.statusCode, 200)
  assert.equal(overview.statusCode, 200)
  const overviewPayload: unknown = overview.json()
  assert.deepEqual(overviewPayload, {
    totals: {
      completed_extraction_count: 4,
      extracted_unit_count: 3,
      units_with_observation_count: 2,
      units_without_observation_count: 1,
      observation_count: 2,
      pending_observation_count: 1,
      consumed_observation_count: 1,
    },
    trend_granularity: 'day',
    trend_points: [
      {
        period_start: '2026-10-23',
        extracted_unit_count: 3,
        units_with_observation_count: 2,
      },
    ],
    workflows: [
      {
        source_workflow: 'issue-review',
        extracted_unit_count: 3,
        units_with_observation_count: 2,
        units_without_observation_count: 1,
      },
    ],
  })
  assert.deepEqual(maintenanceControl.json(), control)
  assert.deepEqual(overviewRanges, ['90d'])
  assert.deepEqual(calls, [
    [
      'extractions',
      'cursor-1',
      10,
      {
        sourceWorkflow: 'issue-review',
        sourceRunId: 'run-1',
        hasObservation: true,
      },
    ],
    [
      'observations',
      'cursor-2',
      20,
      { status: 'consumed', consumedRevision: 1 },
    ],
  ])
  await app.close()
})

await test('maintenance input is read and a revision is created with resource semantics', async () => {
  const maintenanceInput = {
    expected_active_revision: 0,
    active_memory_tree_reference: null,
    observations: [
      { extraction_id: 'extraction-1', body_markdown: 'Remember this.' },
    ],
  }
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: () => Promise.resolve(undefined),
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 1, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: (limit) =>
      Promise.resolve(limit === 10 ? maintenanceInput : null),
    createMemoryTreeRevision: (input) =>
      Promise.resolve({
        created: true,
        revision: 1,
        source:
          input.source.kind === 'maintenance'
            ? {
                kind: 'maintenance',
                maintenance_id: input.source.maintenance_id,
              }
            : { kind: 'operator', operation_id: input.source.operation_id },
      }),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const headers = { authorization: 'Bearer secret' }
  const input = await app.inject({
    method: 'GET',
    url: '/v1/maintenance-input?limit=10',
    headers,
  })
  const backlog = await app.inject({
    method: 'GET',
    url: '/v1/observation-backlog',
    headers,
  })
  const created = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/revisions',
    headers,
    payload: {
      expected_active_revision: 0,
      memory_tree_reference: revision.memory_tree_reference,
      source: revision.source,
    },
  })

  assert.deepEqual(backlog.json(), {
    pending_count: 1,
    oldest_pending_created_at: null,
  })
  assert.deepEqual(input.json(), { input: maintenanceInput })
  assert.equal(created.statusCode, 201)
  assert.equal(created.headers.location, '/v1/memory-tree/revisions/1')
  assert.deepEqual(created.json(), {
    created: true,
    revision: 1,
    source: { kind: 'maintenance', maintenance_id: 'maintenance-1' },
  })
  await app.close()
})

function storeWithRevisionFailure(error: Error): MemoryCatalogStore {
  return {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: () => Promise.resolve(undefined),
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.reject(error),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({ revision: 0, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
}

async function postRevision(store: MemoryCatalogStore) {
  const app = await createApp({ store, token: 'secret' })
  try {
    return await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/revisions',
      headers: { authorization: 'Bearer secret' },
      payload: {
        expected_active_revision: 0,
        memory_tree_reference: revision.memory_tree_reference,
        source: revision.source,
      },
    })
  } finally {
    await app.close()
  }
}

function responseCode(response: { json: () => unknown }): unknown {
  const payload = response.json()
  return typeof payload === 'object' && payload !== null && 'code' in payload
    ? payload.code
    : null
}

await test('revision conflicts are declared as 409', async () => {
  const response = await postRevision(
    storeWithRevisionFailure(
      new MemoryTreeRevisionConflictError('stale expected active revision'),
    ),
  )

  assert.equal(response.statusCode, 409)
  assert.equal(responseCode(response), 'CONFLICT')
})

await test('a paused maintenance commit has its own 409 code', async () => {
  const response = await postRevision(
    storeWithRevisionFailure(
      new MaintenancePausedError('Automatic memory maintenance is paused.'),
    ),
  )

  assert.equal(response.statusCode, 409)
  assert.equal(responseCode(response), 'MAINTENANCE_PAUSED')
})

await test('restore moves the active pointer through its own operation', async () => {
  const restores: unknown[] = []
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: () => Promise.resolve(undefined),
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: (input) => {
      restores.push(input)
      return Promise.resolve({
        created: true,
        active_revision: input.restored_revision,
        operation_id: input.operation_id,
      })
    },
    getMemoryTree: () =>
      Promise.resolve({ revision: 2, memory_tree_reference: null }),
    getMemoryTreeRevision: () => Promise.resolve(undefined),
    listMemoryTreeRevisions: () =>
      Promise.resolve({ revisions: [], next_before_revision: null }),
  }
  const app = await createApp({ store, token: 'secret' })
  const payload = {
    operation_id: 'restore-1',
    expected_active_revision: 2,
    restored_revision: 1,
    actor: { kind: 'user', id: 'alice' },
  }
  const response = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/restore',
    headers: { authorization: 'Bearer secret' },
    payload,
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.json(), {
    created: true,
    active_revision: 1,
    operation_id: 'restore-1',
  })
  assert.deepEqual(restores, [payload])
  await app.close()
})

await test('memory tree revision history is queryable through the public contract', async () => {
  const calls: unknown[] = []
  const store: MemoryCatalogStore = {
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    getExtraction: () => Promise.resolve(undefined),
    listExtractions: () =>
      Promise.resolve({ extractions: [], next_cursor: null }),
    listObservations: () =>
      Promise.resolve({ observations: [], next_cursor: null }),
    getObservationBacklog: () =>
      Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
    getCatalogOverview: () => Promise.resolve(emptyOverview),
    getMaintenanceControl: () =>
      Promise.resolve({
        state: 'enabled',
        generation: 0,
        changed_by: { kind: 'service', id: 'memory-catalog' },
        changed_at: '2026-10-23T00:00:00.000Z',
      }),
    changeMaintenanceControl: () => Promise.reject(new Error('not used')),
    getMaintenanceInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    getMemoryTree: () =>
      Promise.resolve({
        revision: revision.revision,
        memory_tree_reference: revision.memory_tree_reference,
      }),
    getMemoryTreeRevision: (requested) =>
      Promise.resolve(requested === revision.revision ? revision : undefined),
    listMemoryTreeRevisions: (beforeRevision, limit) => {
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
    url: '/v1/memory-tree/revisions/1',
    headers,
  })
  const active = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree',
    headers,
  })
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/revisions/2',
    headers,
  })
  const page = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/revisions?before_revision=3&limit=10',
    headers,
  })
  const excessivePage = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/revisions?limit=101',
    headers,
  })

  assert.equal(one.statusCode, 200)
  assert.deepEqual(active.json(), {
    revision: revision.revision,
    memory_tree_reference: revision.memory_tree_reference,
  })
  assert.deepEqual(one.json(), revision)
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), {
    error: 'Memory tree revision not found: 2',
    code: 'NOT_FOUND',
  })
  assert.deepEqual(page.json(), {
    revisions: [revision],
    next_before_revision: null,
  })
  // The bound lives in the contract, so the page is refused by the same query
  // validation that guards every other declared parameter, before the store is read.
  assert.equal(excessivePage.statusCode, 400)
  assert.equal(excessivePage.json<{ code?: string }>().code, 'INVALID_BODY')
  assert.deepEqual(calls, [{ beforeRevision: 3, limit: 10 }])
  await app.close()
})
