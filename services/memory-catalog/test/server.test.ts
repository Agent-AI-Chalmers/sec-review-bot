import { expect, test } from 'vitest'

import type { MemoryCatalogStore } from '../src/catalog-store.js'
import {
  ExtractionConflictError,
  AutomationPausedError,
  PublicationAbandonedError,
  MemoryTreeVersionConflictError,
} from '../src/catalog-store.js'
import { createApp } from '../src/server.js'
import { learningReport, reorganizationReport } from './maintenance-report.js'

const auth = {
  workerToken: 'worker-secret',
  operatorToken: 'operator-secret',
}
const workerHeaders = { authorization: `Bearer ${auth.workerToken}` }
const operatorHeaders = { authorization: `Bearer ${auth.operatorToken}` }

const version = {
  version: 1,
  predecessor_version: null,
  memory_tree_reference: {
    uri: 's3://sec-review/memory/trees/1.tar.zst',
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd',
    size_bytes: 42,
  },
  source: {
    kind: 'learning' as const,
    operation_id: 'maintenance-1',
    observation_ids: ['extraction-1'],
    trajectory_reference: {
      uri: 's3://sec-review/memory/trajectories/memory-maintainer/trajectory.v1.jsonl.zst',
      digest: `sha256:${'b'.repeat(64)}`,
      media_type: 'application/zstd',
      size_bytes: 21,
    },
    maintenance_report: learningReport(['extraction-1']),
  },
  created_at: '2026-10-23T00:00:00.000Z',
}

const versionCreationResult = {
  created: true,
  version: 1,
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
  observations: [
    { observation_id: 'extraction-1', body_markdown: 'Remember this.' },
  ],
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

test('the contract authenticates and validates extraction registration', async () => {
  const extractions: unknown[] = []
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: (input) => {
      extractions.push(input)
      return Promise.resolve(true)
    },
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeVersion: () => Promise.resolve(versionCreationResult),
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ version: 0, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  for (const [method, url] of [
    ['GET', '/v1/maintenance-control'],
    ['POST', '/v1/maintenance-control/pause'],
    ['POST', '/v1/maintenance-control/resume'],
  ] as const) {
    const obsolete = await app.inject({ method, url, headers: operatorHeaders })
    expect(obsolete.statusCode).toBe(404)
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
  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: workerHeaders,
    payload: {
      ...extraction,
      observations: [extraction.observations[0], extraction.observations[0]],
    },
  })
  expect(duplicate.statusCode).toBe(400)
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: workerHeaders,
    payload: extraction,
  })

  expect(unauthorized.statusCode).toBe(401)
  expect(invalid.statusCode).toBe(400)
  expect(registered.json()).toStrictEqual({ ok: true, created: true })
  expect(extractions).toStrictEqual([extraction])
  await app.close()
})

test('worker and operator credentials are restricted to their write roles', async () => {
  const store = storeWithVersionFailure(new Error('not used'))
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
    payload: { operation_id: 'pause-1', expected_version: 0 },
  })
  const workerManualVersion = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/versions',
    headers: workerHeaders,
    payload: {
      expected_active_version: 0,
      memory_tree_reference: version.memory_tree_reference,
      source: { kind: 'manual', operation_id: 'edit-1' },
    },
  })
  const operatorLearningVersion = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/versions',
    headers: operatorHeaders,
    payload: {
      expected_active_version: 0,
      memory_tree_reference: version.memory_tree_reference,
      source: version.source,
    },
  })
  const operatorReorganizationVersion = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/versions',
    headers: operatorHeaders,
    payload: {
      expected_active_version: 0,
      memory_tree_reference: version.memory_tree_reference,
      source: {
        kind: 'reorganization',
        operation_id: 'maintenance-1',
        trajectory_reference: version.source.trajectory_reference,
        maintenance_report: reorganizationReport,
      },
    },
  })

  expect(operatorRegistration.statusCode).toBe(401)
  expect(workerPause.statusCode).toBe(401)
  expect(workerManualVersion.statusCode).toBe(401)
  expect(operatorLearningVersion.statusCode).toBe(401)
  expect(operatorReorganizationVersion.statusCode).toBe(401)
  await app.close()
})

test('an extraction identity conflict is a declared 409', async () => {
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () =>
      Promise.reject(new ExtractionConflictError('different content')),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeVersion: () => Promise.resolve(versionCreationResult),
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ version: 0, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const response = await app.inject({
    method: 'POST',
    url: '/v1/extractions',
    headers: workerHeaders,
    payload: extraction,
  })

  expect(response.statusCode).toBe(409)
  const payload: unknown = response.json()
  expect(
    typeof payload === 'object' && payload !== null && 'code' in payload
      ? payload.code
      : null,
  ).toBe('CONFLICT')
  await app.close()
})

test('completed extractions are queryable with or without an observation', async () => {
  const records = new Map([
    ['extraction-1', { ...extraction, created_at: '2026-10-23T00:00:00.000Z' }],
    [
      'extraction-2',
      {
        ...extraction,
        extraction_id: 'extraction-2',
        observations: [],
        created_at: '2026-10-23T00:01:00.000Z',
      },
    ],
  ])
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeVersion: () => Promise.resolve(versionCreationResult),
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ version: 0, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
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

  expect(produced.json()).toStrictEqual(records.get('extraction-1'))
  expect(empty.json()).toStrictEqual(records.get('extraction-2'))
  expect(missing.statusCode).toBe(404)
  expect(missing.json()).toStrictEqual({
    error: 'Memory extraction not found: missing',
    code: 'NOT_FOUND',
  })
  await app.close()
})

test('UI catalog reads expose paginated records and durable control state', async () => {
  const calls: unknown[] = []
  const overviewRanges: string[] = []
  const automationChanges: unknown[] = []
  const control = {
    state: 'paused' as const,
    version: 2,
    changed_by: { kind: 'user' as const, id: 'alice' },
    changed_at: '2026-10-23T01:00:00.000Z',
  }
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
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
    createMemoryTreeVersion: () => Promise.resolve(versionCreationResult),
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
              observation_id: 'extraction-1',
              source_run_id: 'run-1',
              source_unit_id: 'review',
              body_markdown: 'Remember this.',
              consumed_version: 1,
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
        Promise.resolve({ version: 0, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
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
    url: '/v1/observations?cursor=cursor-2&limit=20&status=consumed&consumed_version=1',
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

  expect(extractions.statusCode).toBe(200)
  expect(observations.statusCode).toBe(200)
  expect(overview.statusCode).toBe(200)
  const overviewPayload: unknown = overview.json()
  expect(overviewPayload).toStrictEqual({
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
  expect(memoryTreeAutomation.json()).toStrictEqual(control)
  expect(overviewRanges).toStrictEqual(['90d'])
  expect(calls).toStrictEqual([
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
      { status: 'consumed', consumedVersion: 1 },
    ],
  ])
  for (const [action, state] of [
    ['pause', 'paused'],
    ['resume', 'enabled'],
  ] as const) {
    const payload = {
      operation_id: `automation-${action}`,
      expected_version: 2,
    }
    const response = await app.inject({
      method: 'POST',
      url: `/v1/memory-tree/automation/${action}`,
      headers: operatorHeaders,
      payload,
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toStrictEqual({
      created: true,
      automation: { ...control, state },
    })
    expect(automationChanges.at(-1)).toStrictEqual([
      state,
      { ...payload, actor: { kind: 'service', id: 'memory-catalog-operator' } },
    ])
  }
  await app.close()
})

test('learning input is read and a version is created with resource semantics', async () => {
  const learningInput = {
    expected_active_version: 0,
    active_memory_tree_reference: null,
    observations: [
      { observation_id: 'extraction-1', body_markdown: 'Remember this.' },
    ],
  }
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: (limit) =>
      Promise.resolve(limit === 10 ? learningInput : null),
    createMemoryTreeVersion: (input) =>
      Promise.resolve({
        created: true,
        version: 1,
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ version: 0, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
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
    url: '/v1/memory-tree/versions',
    headers,
    payload: {
      expected_active_version: 0,
      memory_tree_reference: version.memory_tree_reference,
      source: version.source,
    },
  })

  expect(backlog.json()).toStrictEqual({
    pending_count: 1,
    oldest_pending_created_at: null,
  })
  expect(input.json()).toStrictEqual({ input: learningInput })
  expect(created.statusCode).toBe(201)
  expect(created.headers.location).toBe('/v1/memory-tree/versions/1')
  expect(created.json()).toStrictEqual({
    created: true,
    version: 1,
    source: { kind: 'learning', operation_id: 'maintenance-1' },
  })
  await app.close()
})

function storeWithVersionFailure(error: Error): MemoryCatalogStore {
  return {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeVersion: () => Promise.reject(error),
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ version: 0, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
    },
  }
}

async function postVersion(store: MemoryCatalogStore) {
  const app = await createApp({ store, ...auth })
  try {
    return await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/versions',
      headers: workerHeaders,
      payload: {
        expected_active_version: 0,
        memory_tree_reference: version.memory_tree_reference,
        source: version.source,
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

test('version conflicts are declared as 409', async () => {
  const response = await postVersion(
    storeWithVersionFailure(
      new MemoryTreeVersionConflictError('stale expected active version'),
    ),
  )

  expect(response.statusCode).toBe(409)
  expect(responseCode(response)).toBe('CONFLICT')
})

test('maintenance reports must match consumed extractions before reaching the store', async () => {
  const store = storeWithVersionFailure(new Error('store must not be called'))
  const reached: string[] = []
  store.reserveVersionPublication = () => {
    reached.push('reserve')
    return Promise.reject(new Error('store must not be called'))
  }
  store.confirmVersionPublication = () => {
    reached.push('confirm')
    return Promise.reject(new Error('store must not be called'))
  }
  const decision = version.source.maintenance_report.observation_decisions[0]
  const invalidSources = [
    {
      ...version.source,
      maintenance_report: { summary: 'Missing.', observation_decisions: [] },
    },
    {
      ...version.source,
      maintenance_report: {
        summary: 'Duplicate.',
        observation_decisions: [decision, decision],
      },
    },
    {
      ...version.source,
      maintenance_report: {
        summary: 'No topics.',
        observation_decisions: [{ ...decision, topics: [] }],
      },
    },
    {
      kind: 'reorganization',
      operation_id: 'maintenance-1',
      trajectory_reference: version.source.trajectory_reference,
      maintenance_report: {
        summary: 'Invented.',
        observation_decisions: [decision],
      },
    },
  ]
  const app = await createApp({ store, ...auth })
  try {
    for (const source of invalidSources)
      for (const url of [
        '/v1/memory-tree/versions',
        '/v1/memory-tree/versions/publications/reserve',
        '/v1/memory-tree/versions/publications/confirm',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: workerHeaders,
          payload: {
            expected_active_version: 0,
            memory_tree_reference: version.memory_tree_reference,
            source,
          },
        })
        expect(
          response.statusCode,
          `${url} ${source.maintenance_report.summary}`,
        ).toBe(400)
        expect(responseCode(response)).toBe('INVALID_BODY')
      }
  } finally {
    await app.close()
  }
  expect(reached).toStrictEqual([])
})

test('a paused automatic version commit has its own 409 code', async () => {
  const response = await postVersion(
    storeWithVersionFailure(
      new AutomationPausedError(
        'Automatic memory-tree version commits are paused.',
      ),
    ),
  )

  expect(response.statusCode).toBe(409)
  expect(responseCode(response)).toBe('AUTOMATION_PAUSED')
})

test('restore moves the active pointer through its own operation', async () => {
  const restores: unknown[] = []
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeVersion: () => Promise.resolve(versionCreationResult),
    restoreMemoryTree: (input) => {
      restores.push(input)
      return Promise.resolve({
        created: true,
        active_version: input.restored_version,
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({ version: 2, memory_tree_reference: null }),
      getMemoryTreeVersion: () => Promise.resolve(undefined),
      listMemoryTreeVersions: () =>
        Promise.resolve({ versions: [], next_before_version: null }),
    },
  }
  const app = await createApp({ store, ...auth })
  const payload = {
    operation_id: 'restore-1',
    expected_active_version: 2,
    restored_version: 1,
  }
  const response = await app.inject({
    method: 'POST',
    url: '/v1/memory-tree/restore',
    headers: operatorHeaders,
    payload,
  })

  expect(response.statusCode).toBe(201)
  expect(response.json()).toStrictEqual({
    created: true,
    active_version: 1,
    operation_id: 'restore-1',
  })
  expect(restores).toStrictEqual([
    {
      ...payload,
      actor: { kind: 'service', id: 'memory-catalog-operator' },
    },
  ])
  await app.close()
})

test('memory tree version history is queryable through the public contract', async () => {
  const calls: unknown[] = []
  const store: MemoryCatalogStore = {
    reserveExtractionPublication: () => Promise.reject(new Error('unused')),
    confirmExtractionPublication: () => Promise.reject(new Error('unused')),
    listExtractionPublications: () => Promise.resolve([]),
    abandonVersionPublications: () => Promise.resolve([]),
    reserveVersionPublication: () => Promise.reject(new Error('unused')),
    confirmVersionPublication: () => Promise.reject(new Error('unused')),
    listVersionPublications: () => Promise.resolve([]),
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    registerExtraction: () => Promise.resolve(true),
    changeMemoryTreeAutomation: () => Promise.reject(new Error('not used')),
    getLearningInput: () => Promise.resolve(null),
    createMemoryTreeVersion: () => Promise.resolve(versionCreationResult),
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
          version: 0,
          changed_by: { kind: 'service', id: 'memory-catalog' },
          changed_at: '2026-10-23T00:00:00.000Z',
        }),
      getMemoryTree: () =>
        Promise.resolve({
          version: version.version,
          memory_tree_reference: version.memory_tree_reference,
        }),
      getMemoryTreeVersion: (requested) =>
        Promise.resolve(requested === version.version ? version : undefined),
      listMemoryTreeVersions: (beforeVersion, limit) => {
        calls.push({ beforeVersion, limit })
        return Promise.resolve({
          versions: [version],
          next_before_version: null,
        })
      },
    },
  }
  const app = await createApp({ store, ...auth })
  const headers = operatorHeaders

  const one = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/versions/1',
    headers,
  })
  const active = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree',
    headers,
  })
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/versions/2',
    headers,
  })
  const page = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/versions?before_version=3&limit=10',
    headers,
  })
  const excessivePage = await app.inject({
    method: 'GET',
    url: '/v1/memory-tree/versions?limit=101',
    headers,
  })

  expect(one.statusCode).toBe(200)
  expect(active.json()).toStrictEqual({
    version: version.version,
    memory_tree_reference: version.memory_tree_reference,
  })
  expect(one.json()).toStrictEqual(version)
  expect(missing.statusCode).toBe(404)
  expect(missing.json()).toStrictEqual({
    error: 'Memory tree version not found: 2',
    code: 'NOT_FOUND',
  })
  expect(page.json()).toStrictEqual({
    versions: [version],
    next_before_version: null,
  })
  // The bound lives in the contract, so the page is refused by the same query
  // validation that guards every other declared parameter, before the store is read.
  expect(excessivePage.statusCode).toBe(400)
  expect(excessivePage.json<{ code?: string }>().code).toBe('INVALID_BODY')
  expect(calls).toStrictEqual([{ beforeVersion: 3, limit: 10 }])
  await app.close()
})

test('publication endpoints enforce producer roles and return complete recovery intents', async () => {
  const store = storeWithVersionFailure(new Error('unused'))
  const intent = {
    expected_active_version: 0,
    memory_tree_reference: version.memory_tree_reference,
    source: version.source,
  }
  const calls: unknown[] = []
  store.reserveVersionPublication = (input) => {
    calls.push(input)
    return Promise.resolve({ intent: input, status: 'reserved' })
  }
  store.confirmVersionPublication = (input) =>
    Promise.resolve({ intent: input, status: 'present' })
  store.listVersionPublications = () =>
    Promise.resolve([{ intent, status: 'reserved' }])
  store.reserveExtractionPublication = (input) =>
    Promise.resolve({ intent: input, status: 'reserved' })
  const app = await createApp({ store, ...auth })
  try {
    for (const action of ['reserve', 'confirm']) {
      const denied = await app.inject({
        method: 'POST',
        url: `/v1/memory-tree/versions/publications/${action}`,
        headers: operatorHeaders,
        payload: intent,
      })
      expect(denied.statusCode).toBe(401)
      const accepted = await app.inject({
        method: 'POST',
        url: `/v1/memory-tree/versions/publications/${action}`,
        headers: workerHeaders,
        payload: intent,
      })
      expect(accepted.statusCode).toBe(200)
      expect(accepted.json<{ intent: unknown }>().intent).toStrictEqual(intent)
    }
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/memory-tree/versions/publications/learning/maintenance-1',
      headers: workerHeaders,
    })
    expect(listed.json()).toStrictEqual({
      publications: [{ intent, status: 'reserved' }],
    })
    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/memory-tree/versions/publications/manual/edit-1',
      headers: workerHeaders,
    })
    expect(forbidden.statusCode).toBe(401)
    const extractionIntent = {
      registration: extraction,
      summary: 'Original summary.',
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/extractions/publications/reserve',
          headers: operatorHeaders,
          payload: extractionIntent,
        })
      ).statusCode,
    ).toBe(401)
    const reserved = await app.inject({
      method: 'POST',
      url: '/v1/extractions/publications/reserve',
      headers: workerHeaders,
      payload: extractionIntent,
    })
    expect(reserved.json()).toStrictEqual({
      intent: extractionIntent,
      status: 'reserved',
    })
    expect(calls.length).toBe(1)
  } finally {
    await app.close()
  }
})

test('only workers can abandon automatic publications and abandoned commits have a distinct error code', async () => {
  const store = storeWithVersionFailure(
    new PublicationAbandonedError('Version operation has been abandoned.'),
  )
  const calls: unknown[] = []
  store.abandonVersionPublications = (input) => {
    calls.push(input)
    return Promise.resolve([])
  }
  const app = await createApp({ store, ...auth })
  try {
    const payload = { kind: 'learning', operation_id: 'abandon-1' }
    const url = '/v1/memory-tree/versions/publications/abandon'
    const denied = await app.inject({
      method: 'POST',
      url,
      headers: operatorHeaders,
      payload,
    })
    expect(denied.statusCode).toBe(401)
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers: workerHeaders,
      payload: { ...payload, kind: 'manual' },
    })
    expect(invalid.statusCode).toBe(400)
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers: workerHeaders,
      payload,
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toStrictEqual({ publications: [] })
    expect(calls).toStrictEqual([payload])
    const committed = await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/versions',
      headers: workerHeaders,
      payload: {
        expected_active_version: 0,
        memory_tree_reference: version.memory_tree_reference,
        source: version.source,
      },
    })
    expect(committed.statusCode).toBe(409)
    expect(committed.json<{ code: string }>().code).toBe(
      'PUBLICATION_ABANDONED',
    )
  } finally {
    await app.close()
  }
})
