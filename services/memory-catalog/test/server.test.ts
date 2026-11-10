import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MemoryCatalogStore } from '../src/catalog-store.js'
import {
  ExtractionConflictError,
  AutomationPausedError,
  PublicationAbandonedError,
  MemoryTreeRevisionConflictError,
} from '../src/catalog-store.js'
import { createApp } from '../src/server.js'

const auth = {
  workerToken: 'worker-secret',
  operatorToken: 'operator-secret',
}
const workerHeaders = { authorization: `Bearer ${auth.workerToken}` }
const operatorHeaders = { authorization: `Bearer ${auth.operatorToken}` }

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
    kind: 'learning' as const,
    operation_id: 'maintenance-1',
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
  source: { kind: 'learning' as const, operation_id: 'maintenance-1' },
}

const extraction = {
  extraction_id: 'extraction-1',
  source_workflow: 'issue-review',
  source_run_id: 'run-1',
  source_unit_id: 'review',
  execution_archive_digest: `sha256:${'b'.repeat(64)}`,
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
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: (input) => {
      extractions.push(input)
      return Promise.resolve(true)
    },
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
      getExtraction: () => Promise.resolve(undefined),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ revision: 0, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  for (const [method, url] of [
    ['GET', '/v1/maintenance-control'],
    ['POST', '/v1/maintenance-control/pause'],
    ['POST', '/v1/maintenance-control/resume'],
  ] as const) {
    const obsolete = await app.inject({ method, url, headers: operatorHeaders })
    assert.equal(obsolete.statusCode, 404)
  }

  const unauthorized = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    payload: extraction,
  })
  const invalid = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: workerHeaders,
    payload: { ...extraction, unknown: true },
  })
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: workerHeaders,
    payload: extraction,
  })

  assert.equal(unauthorized.statusCode, 401)
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(registered.json(), { ok: true, created: true })
  assert.deepEqual(extractions, [extraction])
  await app.close()
})

await test('worker and operator credentials are restricted to their write roles', async () => {
  const store = storeWithRevisionFailure(new Error('not used'))
  const app = await createApp({ store, ...auth })
  const operatorRegistration = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: operatorHeaders,
    payload: extraction,
  })
  const workerPause = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/automation/pause',
    headers: workerHeaders,
    payload: { operation_id: 'pause-1', expected_generation: 0 },
  })
  const workerManualRevision = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/revisions',
    headers: workerHeaders,
    payload: {
      expected_active_revision: 0,
      memory_tree_reference: revision.memory_tree_reference,
      source: { kind: 'manual', operation_id: 'edit-1' },
    },
  })
  const operatorLearningRevision = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/revisions',
    headers: operatorHeaders,
    payload: {
      expected_active_revision: 0,
      memory_tree_reference: revision.memory_tree_reference,
      source: revision.source,
    },
  })
  const operatorReorganizationRevision = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/revisions',
    headers: operatorHeaders,
    payload: {
      expected_active_revision: 0,
      memory_tree_reference: revision.memory_tree_reference,
      source: {
        kind: 'reorganization',
        operation_id: 'maintenance-1',
        trajectory_reference: revision.source.trajectory_reference,
      },
    },
  })

  assert.equal(operatorRegistration.statusCode, 401)
  assert.equal(workerPause.statusCode, 401)
  assert.equal(workerManualRevision.statusCode, 401)
  assert.equal(operatorLearningRevision.statusCode, 401)
  assert.equal(operatorReorganizationRevision.statusCode, 401)
  await app.close()
})

await test('an extraction identity conflict is a declared 409', async () => {
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () =>
      Promise.reject(new ExtractionConflictError('different content')),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
      getExtraction: () => Promise.resolve(undefined),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ revision: 0, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: workerHeaders,
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
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
      getExtraction: (extractionId) =>
        Promise.resolve(records.get(extractionId)),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ revision: 0, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const headers = workerHeaders

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
  const automationChanges: unknown[] = []
  const control = {
    state: 'paused' as const,
    generation: 2,
    changed_by: { kind: 'user' as const, id: 'alice' },
    changed_at: '2026-10-23T01:00:00.000Z',
  }
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: (state, input) => {
      automationChanges.push([state, input])
      return Promise.resolve({
        created: true,
        automation: { ...control, state },
      })
    },
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
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
      getMemoryTreeAutomation: () => Promise.resolve(control),
      getMemoryTree: () =>
        Promise.resolve({ revision: 0, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const headers = workerHeaders

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
  const memoryTreeAutomation = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/automation',
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
  assert.deepEqual(memoryTreeAutomation.json(), control)
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
  for (const [action, state] of [
    ['pause', 'paused'],
    ['resume', 'enabled'],
  ] as const) {
    const payload = {
      operation_id: `automation-${action}`,
      expected_generation: 2,
    }
    const response = await app.inject({
      method: 'POST',
      url: `/v1/memory-tree/automation/${action}`,
      headers: operatorHeaders,
      payload,
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), {
      created: true,
      automation: { ...control, state },
    })
    assert.deepEqual(automationChanges.at(-1), [
      state,
      { ...payload, actor: { kind: 'service', id: 'memory-catalog-operator' } },
    ])
  }
  await app.close()
})

await test('learning input is read and a revision is created with resource semantics', async () => {
  const learningInput = {
    expected_active_revision: 0,
    active_memory_tree_reference: null,
    observations: [
      { extraction_id: 'extraction-1', body_markdown: 'Remember this.' },
    ],
  }
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: (limit) =>
      Promise.resolve(limit === 10 ? learningInput : null),
    createMemoryTreeRevision: (input) =>
      Promise.resolve({
        created: true,
        revision: 1,
        source:
          input.source.kind === 'learning'
            ? {
                kind: 'learning',
                operation_id: input.source.operation_id,
              }
            : input.source.kind === 'reorganization'
              ? {
                  kind: 'reorganization',
                  operation_id: input.source.operation_id,
                }
              : { kind: 'manual', operation_id: input.source.operation_id },
      }),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
      getExtraction: () => Promise.resolve(undefined),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 1, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ revision: 0, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const headers = workerHeaders
  const input = await app.inject({
    method: 'GET',
    url: '/v1/learning-input?limit=10',
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
  assert.deepEqual(input.json(), { input: learningInput })
  assert.equal(created.statusCode, 201)
  assert.equal(created.headers.location, '/v1/memory-tree/revisions/1')
  assert.deepEqual(created.json(), {
    created: true,
    revision: 1,
    source: { kind: 'learning', operation_id: 'maintenance-1' },
  })
  await app.close()
})

function storeWithRevisionFailure(error: Error): MemoryCatalogStore {
  return {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.reject(error),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
      getExtraction: () => Promise.resolve(undefined),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ revision: 0, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
}

async function postRevision(store: MemoryCatalogStore) {
  const app = await createApp({ store, ...auth })
  try {
    return await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/revisions',
      headers: workerHeaders,
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

await test('a paused automatic revision commit has its own 409 code', async () => {
  const response = await postRevision(
    storeWithRevisionFailure(
      new AutomationPausedError(
        'Automatic memory-tree revision commits are paused.',
      ),
    ),
  )

  assert.equal(response.statusCode, 409)
  assert.equal(responseCode(response), 'AUTOMATION_PAUSED')
})

await test('restore moves the active pointer through its own operation', async () => {
  const restores: unknown[] = []
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: (input) => {
      restores.push(input)
      return Promise.resolve({
        created: true,
        active_revision: input.restored_revision,
        operation_id: input.operation_id,
      })
    },
    queries: {
      getExtraction: () => Promise.resolve(undefined),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ revision: 2, memory_tree_reference: null }),
      getMemoryTreeRevision: () => Promise.resolve(undefined),
      listMemoryTreeRevisions: () =>
        Promise.resolve({ revisions: [], next_before_revision: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const payload = {
    operation_id: 'restore-1',
    expected_active_revision: 2,
    restored_revision: 1,
  }
  const response = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/restore',
    headers: operatorHeaders,
    payload,
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.json(), {
    created: true,
    active_revision: 1,
    operation_id: 'restore-1',
  })
  assert.deepEqual(restores, [
    {
      ...payload,
      actor: { kind: 'service', id: 'memory-catalog-operator' },
    },
  ])
  await app.close()
})

await test('memory tree revision history is queryable through the public contract', async () => {
  const calls: unknown[] = []
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonRevisionPublications: () => Promise.resolve([]),
    reserveRevisionPublication: () => Promise.reject(new Error('unused')),
    confirmRevisionPublication: () => Promise.reject(new Error('unused')),
    listRevisionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeRevision: () => Promise.resolve(revisionCreationResult),
    restoreMemoryTree: () => Promise.reject(new Error('not used')),
    queries: {
      getExtraction: () => Promise.resolve(undefined),
      listExtractions: () =>
        Promise.resolve({ extractions: [], next_cursor: null }),
      listObservations: () =>
        Promise.resolve({ observations: [], next_cursor: null }),
      getObservationBacklog: () =>
        Promise.resolve({ pending_count: 0, oldest_pending_created_at: null }),
      getCatalogOverview: () => Promise.resolve(emptyOverview),
      getMemoryTreeAutomation: () =>
        Promise.resolve({
          state: 'enabled',
          generation: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
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
    },
  }
  const app = await createApp({ store, ...auth })
  const headers = operatorHeaders

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

await test('publication endpoints enforce producer roles and return complete recovery intents', async () => {
  const store = storeWithRevisionFailure(new Error('unused'))
  const intent = {
    expected_active_revision: 0,
    memory_tree_reference: revision.memory_tree_reference,
    source: revision.source,
  }
  const calls: unknown[] = []
  store.reserveRevisionPublication = (input) => {
    calls.push(input)
    return Promise.resolve({ intent: input, status: 'reserved' })
  }
  store.confirmRevisionPublication = (input) =>
    Promise.resolve({ intent: input, status: 'present' })
  store.listRevisionPublications = () =>
    Promise.resolve([{ intent, status: 'reserved' }])
  store.reserveExtractionPublication = (input) =>
    Promise.resolve({ intent: input, status: 'reserved' })
  const app = await createApp({ store, ...auth })
  try {
    for (const action of ['reserve', 'confirm']) {
      const denied = await app.inject({
        method: 'POST',
        url: `/v1/memory-tree/revisions/publications/${action}`,
        headers: operatorHeaders,
        payload: intent,
      })
      assert.equal(denied.statusCode, 401)
      const accepted = await app.inject({
        method: 'POST',
        url: `/v1/memory-tree/revisions/publications/${action}`,
        headers: workerHeaders,
        payload: intent,
      })
      assert.equal(accepted.statusCode, 200)
      assert.deepEqual(accepted.json<{ intent: unknown }>().intent, intent)
    }
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/memory-tree/revisions/publications/learning/maintenance-1',
      headers: workerHeaders,
    })
    assert.deepEqual(listed.json(), {
      publications: [{ intent, status: 'reserved' }],
    })
    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/memory-tree/revisions/publications/manual/edit-1',
      headers: workerHeaders,
    })
    assert.equal(forbidden.statusCode, 401)
    const extractionIntent = {
      registration: extraction,
      summary: 'Original summary.',
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/extractions/publications/reserve',
          headers: operatorHeaders,
          payload: extractionIntent,
        })
      ).statusCode,
      401,
    )
    const reserved = await app.inject({
      method: 'POST',
      url: '/v1/extractions/publications/reserve',
      headers: workerHeaders,
      payload: extractionIntent,
    })
    assert.deepEqual(reserved.json(), {
      intent: extractionIntent,
      status: 'reserved',
    })
    assert.equal(calls.length, 1)
  } finally {
    await app.close()
  }
})

await test('only workers can abandon automatic publications and abandoned commits have a distinct error code', async () => {
  const store = storeWithRevisionFailure(
    new PublicationAbandonedError('Revision operation has been abandoned.'),
  )
  const calls: unknown[] = []
  store.abandonRevisionPublications = (input) => {
    calls.push(input)
    return Promise.resolve([])
  }
  const app = await createApp({ store, ...auth })
  try {
    const payload = { kind: 'learning', operation_id: 'abandon-1' }
    const url = '/v1/memory-tree/revisions/publications/abandon'
    const denied = await app.inject({
      method: 'POST',
      url,
      headers: operatorHeaders,
      payload,
    })
    assert.equal(denied.statusCode, 401)
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers: workerHeaders,
      payload: { ...payload, kind: 'manual' },
    })
    assert.equal(invalid.statusCode, 400)
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers: workerHeaders,
      payload,
    })
    assert.equal(accepted.statusCode, 200)
    assert.deepEqual(accepted.json(), { publications: [] })
    assert.deepEqual(calls, [payload])
    const committed = await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/revisions',
      headers: workerHeaders,
      payload: {
        expected_active_revision: 0,
        memory_tree_reference: revision.memory_tree_reference,
        source: revision.source,
      },
    })
    assert.equal(committed.statusCode, 409)
    assert.equal(
      committed.json<{ code: string }>().code,
      'PUBLICATION_ABANDONED',
    )
  } finally {
    await app.close()
  }
})
