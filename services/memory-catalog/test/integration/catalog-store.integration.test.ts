import crypto from 'node:crypto'
import { expect, test as base } from 'vitest'

import { Pool } from 'pg'

import { PostgresMemoryCatalogQueries } from '../../src/catalog-queries.js'

import {
  ExtractionConflictError,
  AutomationPausedError,
  MemoryTreeVersionConflictError,
  PostgresMemoryCatalogStore
} from '../../src/catalog-store.js'
import type {
  ArtifactReference,
  ExtractionRegistration
} from '../../src/contract-types-generated.js'
import { learningReport, reorganizationReport } from '../maintenance-report.js'

const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl === undefined)
  throw new Error('TEST_DATABASE_URL is required for integration tests.')

function artifact(name: string, digestCharacter: string): ArtifactReference {
  return {
    uri: `s3://sec-review/memory/${name}`,
    digest: `sha256:${digestCharacter.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 42
  }
}

const observationBody = 'Preserve this repository-specific fact.'
const extraction: ExtractionRegistration = {
  extraction_id: 'extraction-1',
  source_workflow: 'issue-review',
  source_run_id: 'run-1',
  source_unit_id: 'review',
  execution_archive_digest: `sha256:${'d'.repeat(64)}`,
  trajectory_reference: artifact('trajectories/memory-extractor/trajectory.v1.jsonl.zst', 'c'),
  observations: [{ observation_id: 'extraction-1', body_markdown: observationBody }]
}
const versionInput = {
  expected_active_version: 0,
  memory_tree_reference: artifact('trees/memory-tree.v1.tar.zst', 'a'),
  source: {
    kind: 'learning' as const,
    operation_id: 'maintenance-1',
    observation_ids: [extraction.extraction_id],
    trajectory_reference: artifact('trajectories/memory-maintainer/trajectory.v1.jsonl.zst', 'b'),
    maintenance_report: learningReport([extraction.extraction_id])
  }
}
const reorganizationInput = {
  expected_active_version: 1,
  memory_tree_reference: artifact('trees/reorganized-memory-tree.tar.zst', 'f'),
  source: {
    kind: 'reorganization' as const,
    operation_id: 'reorganization-1',
    trajectory_reference: artifact(
      'trajectories/memory-maintainer/reorganization.v1.jsonl.zst',
      'e'
    ),
    maintenance_report: reorganizationReport
  }
}

const test = base.extend<{
  catalog: { store: PostgresMemoryCatalogStore; pool: Pool }
}>({
  // Vitest requires destructuring even when the fixture has no dependencies.
  // oxlint-disable-next-line no-empty-pattern
  catalog: async ({}, use) => {
    const schema = `memory_catalog_${crypto.randomUUID().replaceAll('-', '_')}`
    await using resources = new AsyncDisposableStack()
    const administrator = new Pool({ connectionString: databaseUrl })
    resources.defer(() => administrator.end())
    await administrator.query(`create schema ${schema}`)
    resources.defer(async () => {
      await administrator.query(`drop schema if exists ${schema} cascade`)
    })
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`
    })
    const store = new PostgresMemoryCatalogStore('unused', pool)
    resources.defer(() => store.close())
    await store.initialize()
    await use({ store, pool })
  }
})

test('extractions are idempotent and learning consumes observations atomically', async ({
  catalog: { store }
}) => {
  const publication = {
    registration: extraction,
    summary: 'Observation produced.'
  }
  await store.reserveExtractionPublication(publication)
  await store.confirmExtractionPublication(publication)
  expect(await store.registerExtraction(extraction)).toBe(true)
  expect(await store.registerExtraction(extraction)).toBe(false)
  await expect(
    store.registerExtraction({
      ...extraction,
      observations: [
        {
          observation_id: 'extraction-1',
          body_markdown: 'Conflicting observation.'
        }
      ]
    })
  ).rejects.toThrow(ExtractionConflictError)

  const stored = await store.queries.getExtraction(extraction.extraction_id)
  expect(stored?.observations[0]?.body_markdown).toBe(extraction.observations[0]?.body_markdown)
  expect(stored?.trajectory_reference).toStrictEqual(extraction.trajectory_reference)

  const extractionPage = await store.queries.listExtractions(undefined, 10, {
    sourceRunId: extraction.source_run_id,
    hasObservation: true
  })
  expect(extractionPage.extractions).toStrictEqual([stored])
  expect(extractionPage.next_cursor).toBe(null)
  expect(
    (
      await store.queries.listObservations(undefined, 10, {
        status: 'pending'
      })
    ).observations[0]?.extraction_id
  ).toBe(extraction.extraction_id)

  const learningInput = await store.getLearningInput(10)
  expect(learningInput?.expected_active_version).toBe(0)
  expect(learningInput?.observations).toStrictEqual([
    {
      observation_id: extraction.extraction_id,
      body_markdown: observationBody
    }
  ])

  await store.reserveVersionPublication(versionInput)
  await store.confirmVersionPublication(versionInput)
  expect(await store.createMemoryTreeVersion(versionInput)).toStrictEqual({
    created: true,
    version: 1,
    source: { kind: 'learning', operation_id: 'maintenance-1' }
  })
  expect(await store.createMemoryTreeVersion(versionInput)).toStrictEqual({
    created: false,
    version: 1,
    source: { kind: 'learning', operation_id: 'maintenance-1' }
  })

  expect((await store.queries.getObservationBacklog()).pending_count).toBe(0)
  expect((await store.queries.getMemoryTree()).version).toBe(1)
  expect((await store.queries.getMemoryTreeVersion(1))?.predecessor_version).toBe(null)

  const history = await store.queries.listMemoryTreeVersions(undefined, 10)
  expect(history.versions).toStrictEqual([await store.queries.getMemoryTreeVersion(1)])
  expect(history.next_before_version).toBe(null)
  const consumed = await store.queries.listObservations(undefined, 10, {
    status: 'consumed',
    consumedVersion: 1
  })
  expect(consumed.observations[0]?.consumed_version).toBe(1)
  expect(
    (
      await store.queries.listObservations(undefined, 10, {
        status: 'pending'
      })
    ).observations
  ).toStrictEqual([])

  await expect(
    store.createMemoryTreeVersion({
      expected_active_version: 0,
      memory_tree_reference: artifact('trees/operator-memory-tree.tar.zst', 'e'),
      source: {
        kind: 'manual',
        operation_id: 'operator-1',
        actor: { kind: 'user', id: 'reviewer@example.com' }
      }
    })
  ).rejects.toThrow(MemoryTreeVersionConflictError)
})

test('version operation identities cannot cross source kinds and reorganization replays safely', async ({
  catalog: { store, pool }
}) => {
  const publication = {
    registration: extraction,
    summary: 'Observation produced.'
  }
  await store.reserveExtractionPublication(publication)
  await store.confirmExtractionPublication(publication)
  await store.registerExtraction(extraction)
  await store.reserveVersionPublication(versionInput)
  await store.confirmVersionPublication(versionInput)
  await store.createMemoryTreeVersion(versionInput)
  for (const source of [
    {
      ...reorganizationInput.source,
      operation_id: versionInput.source.operation_id
    },
    {
      kind: 'manual' as const,
      operation_id: versionInput.source.operation_id,
      actor: { kind: 'user' as const, id: 'reviewer@example.com' }
    }
  ]) {
    const conflictingInput = { ...reorganizationInput, source }
    await store.reserveVersionPublication(conflictingInput)
    await store.confirmVersionPublication(conflictingInput)
    await expect(store.createMemoryTreeVersion(conflictingInput)).rejects.toThrow(
      MemoryTreeVersionConflictError
    )
  }
  expect((await store.queries.getMemoryTree()).version).toBe(1)

  await store.reserveVersionPublication(reorganizationInput)
  await store.confirmVersionPublication(reorganizationInput)
  expect(await store.createMemoryTreeVersion(reorganizationInput)).toStrictEqual({
    created: true,
    version: 2,
    source: { kind: 'reorganization', operation_id: 'reorganization-1' }
  })
  expect(await store.createMemoryTreeVersion(reorganizationInput)).toStrictEqual({
    created: false,
    version: 2,
    source: { kind: 'reorganization', operation_id: 'reorganization-1' }
  })
  const queries = new PostgresMemoryCatalogQueries(pool)
  const version = await queries.getMemoryTreeVersion(2)
  expect(version?.source).toStrictEqual(reorganizationInput.source)
  const reorganizationHistory = await queries.listMemoryTreeVersions(undefined, 10)
  expect(reorganizationHistory.versions[0]).toStrictEqual(version)
})

test('pausing blocks new automatic commits but permits replays, manual edits and restores', async ({
  catalog: { store }
}) => {
  const publication = {
    registration: extraction,
    summary: 'Observation produced.'
  }
  await store.reserveExtractionPublication(publication)
  await store.confirmExtractionPublication(publication)
  await store.registerExtraction(extraction)
  await store.reserveVersionPublication(versionInput)
  await store.confirmVersionPublication(versionInput)
  await store.createMemoryTreeVersion(versionInput)

  await store.reserveVersionPublication(reorganizationInput)
  await store.confirmVersionPublication(reorganizationInput)
  await store.createMemoryTreeVersion(reorganizationInput)
  const actor = { kind: 'user' as const, id: 'reviewer@example.com' }
  const pause = {
    operation_id: 'pause-automation',
    expected_version: 0,
    actor
  }
  const paused = await store.changeMemoryTreeAutomation('paused', pause)
  expect(paused.automation.state).toBe('paused')
  expect((await store.createMemoryTreeVersion(versionInput)).created).toBe(false)
  expect((await store.createMemoryTreeVersion(reorganizationInput)).created).toBe(false)

  const pendingExtraction = {
    ...extraction,
    extraction_id: 'extraction-while-paused',
    observations: [
      {
        observation_id: 'extraction-while-paused',
        body_markdown: observationBody
      }
    ]
  }
  const pendingPublication = {
    registration: pendingExtraction,
    summary: 'Observation while paused.'
  }
  await store.reserveExtractionPublication(pendingPublication)
  await store.confirmExtractionPublication(pendingPublication)
  expect(await store.registerExtraction(pendingExtraction)).toBe(true)
  for (const source of [
    {
      ...versionInput.source,
      operation_id: 'paused-learning',
      observation_ids: [pendingExtraction.extraction_id]
    },
    { ...reorganizationInput.source, operation_id: 'paused-reorganization' }
  ]) {
    const candidate = {
      ...reorganizationInput,
      expected_active_version: 2,
      source
    }
    await store.reserveVersionPublication(candidate)
    await store.confirmVersionPublication(candidate)
    await expect(store.createMemoryTreeVersion(candidate)).rejects.toThrow(AutomationPausedError)
    expect((await store.listVersionPublications(source.kind, source.operation_id))[0]?.status).toBe(
      'abandoned'
    )
  }
  const manual = {
    expected_active_version: 2,
    memory_tree_reference: artifact('trees/manual-while-paused.tar.zst', 'c'),
    source: {
      kind: 'manual' as const,
      operation_id: 'manual-while-paused',
      actor
    }
  }
  await store.reserveVersionPublication(manual)
  await store.confirmVersionPublication(manual)
  expect((await store.createMemoryTreeVersion(manual)).version).toBe(3)
  expect((await store.queries.getObservationBacklog()).pending_count).toBe(1)
  expect(
    (
      await store.restoreMemoryTree({
        operation_id: 'restore-while-paused',
        expected_active_version: 3,
        restored_version: 1,
        actor
      })
    ).active_version
  ).toBe(1)
  const resumed = await store.changeMemoryTreeAutomation('enabled', {
    operation_id: 'resume-automation',
    expected_version: 1,
    actor
  })
  expect(resumed.automation.state).toBe('enabled')
  expect(await store.changeMemoryTreeAutomation('paused', pause)).toStrictEqual({
    ...paused,
    created: false
  })
  expect(await store.queries.getMemoryTreeAutomation()).toStrictEqual(resumed.automation)
})

test('one extraction publishes multiple observations that paginate and consume independently', async ({
  catalog: { store, pool }
}) => {
  const extraction: ExtractionRegistration = {
    extraction_id: 'one-run',
    source_workflow: 'issue-review',
    source_run_id: 'run',
    source_unit_id: 'review',
    execution_archive_digest: `sha256:${'d'.repeat(64)}`,
    trajectory_reference: artifact('extractor', 'c'),
    observations: [
      {
        observation_id: 'lesson-a',
        body_markdown: 'Trace implicit deserialization sinks.'
      },
      {
        observation_id: 'lesson-b',
        body_markdown: 'Preserve serialization semantics.'
      }
    ]
  }
  const intent = {
    registration: extraction,
    summary: 'Two independent lessons.'
  }
  await store.reserveExtractionPublication(intent)
  await store.confirmExtractionPublication(intent)
  expect(await store.registerExtraction(extraction)).toBe(true)
  expect(await store.registerExtraction(extraction)).toBe(false)
  const collision = { ...extraction, extraction_id: 'another-run' }
  const collisionIntent = {
    registration: collision,
    summary: 'Conflicting IDs.'
  }
  await store.reserveExtractionPublication(collisionIntent)
  await store.confirmExtractionPublication(collisionIntent)
  await expect(store.registerExtraction(collision)).rejects.toThrow(ExtractionConflictError)
  expect(await store.queries.getExtraction('another-run')).toBe(undefined)
  expect((await store.listExtractionPublications('another-run'))[0]?.status).toBe('present')
  expect((await store.queries.getExtraction('one-run'))?.observations).toStrictEqual(
    extraction.observations
  )
  expect((await store.queries.listExtractions(undefined, 1, {})).extractions).toHaveLength(1)
  // Equal timestamps force the observation ID to act as the pagination tie-breaker.
  await pool.query('update observations set created_at=$1', ['2026-01-01T00:00:00Z'])
  const first = await store.queries.listObservations(undefined, 1, {})
  expect.assert(first.next_cursor)
  const second = await store.queries.listObservations(first.next_cursor, 1, {})
  expect([
    first.observations[0]?.observation_id,
    second.observations[0]?.observation_id
  ]).toStrictEqual(['lesson-b', 'lesson-a'])
  expect(second.next_cursor).toBe(null)
  const input = await store.getLearningInput(1)
  expect(input?.observations.map((item) => item.observation_id)).toStrictEqual(['lesson-a'])
  const version = {
    expected_active_version: 0,
    memory_tree_reference: artifact('tree', 'e'),
    source: {
      kind: 'learning' as const,
      operation_id: 'learn-one',
      observation_ids: ['lesson-a'],
      trajectory_reference: artifact('maintainer', 'f'),
      maintenance_report: learningReport(['lesson-a'])
    }
  }
  await store.reserveVersionPublication(version)
  await store.confirmVersionPublication(version)
  expect((await store.createMemoryTreeVersion(version)).created).toBe(true)
  expect((await store.createMemoryTreeVersion(version)).created).toBe(false)
  expect(
    (await store.getLearningInput(10))?.observations.map((item) => item.observation_id)
  ).toStrictEqual(['lesson-b'])
  expect((await store.queries.getObservationBacklog()).pending_count).toBe(1)
  const overview = await store.queries.getCatalogOverview('all')
  expect(overview.totals.completed_extraction_count).toBe(1)
  expect(overview.totals.extracted_unit_count).toBe(1)
  expect(overview.totals.observation_count).toBe(2)
})
