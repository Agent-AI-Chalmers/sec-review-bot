import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { Pool } from 'pg'

import { PostgresMemoryCatalogQueries } from '../../src/catalog-queries.js'

import {
  ExtractionConflictError,
  AutomationPausedError,
  MemoryTreeRevisionConflictError,
  PostgresMemoryCatalogStore,
} from '../../src/catalog-store.js'
import type {
  ArtifactReference,
  ExtractionRegistration,
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
    size_bytes: 42,
  }
}

await test('PostgreSQL store preserves extraction and revision invariants', async () => {
  const observationBody = 'Preserve this repository-specific fact.'
  const schema = `memory_catalog_${crypto.randomUUID().replaceAll('-', '_')}`
  const administrator = new Pool({ connectionString: databaseUrl })
  await administrator.query(`create schema ${schema}`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  })
  const store = new PostgresMemoryCatalogStore('unused', pool)

  const extraction: ExtractionRegistration = {
    extraction_id: 'extraction-1',
    source_workflow: 'issue-review',
    source_run_id: 'run-1',
    source_unit_id: 'review',
    execution_archive_digest: `sha256:${'d'.repeat(64)}`,
    trajectory_reference: artifact(
      'trajectories/memory-extractor/trajectory.v1.jsonl.zst',
      'c',
    ),
    observation: { body_markdown: observationBody },
  }

  try {
    await store.initialize()

    const publication = {
      registration: extraction,
      summary: 'Observation produced.',
    }
    await store.reserveExtractionPublication(publication)
    await store.confirmExtractionPublication(publication)
    assert.equal(await store.registerExtraction(extraction), true)
    assert.equal(await store.registerExtraction(extraction), false)
    await assert.rejects(
      store.registerExtraction({
        ...extraction,
        observation: { body_markdown: 'Conflicting observation.' },
      }),
      ExtractionConflictError,
    )

    const stored = await store.queries.getExtraction(extraction.extraction_id)
    assert.equal(
      stored?.observation?.body_markdown,
      extraction.observation?.body_markdown,
    )
    assert.deepEqual(
      stored?.trajectory_reference,
      extraction.trajectory_reference,
    )

    const extractionPage = await store.queries.listExtractions(undefined, 10, {
      sourceRunId: extraction.source_run_id,
      hasObservation: true,
    })
    assert.deepEqual(extractionPage.extractions, [stored])
    assert.equal(extractionPage.next_cursor, null)
    assert.equal(
      (
        await store.queries.listObservations(undefined, 10, {
          status: 'pending',
        })
      ).observations[0]?.extraction_id,
      extraction.extraction_id,
    )

    const learningInput = await store.getLearningInput(10)
    assert.equal(learningInput?.expected_active_revision, 0)
    assert.deepEqual(learningInput?.observations, [
      {
        extraction_id: extraction.extraction_id,
        body_markdown: observationBody,
      },
    ])

    const revisionInput = {
      expected_active_revision: 0,
      memory_tree_reference: artifact('trees/memory-tree.v1.tar.zst', 'a'),
      source: {
        kind: 'learning' as const,
        operation_id: 'maintenance-1',
        extraction_ids: [extraction.extraction_id],
        trajectory_reference: artifact(
          'trajectories/memory-maintainer/trajectory.v1.jsonl.zst',
          'b',
        ),
        maintenance_report: learningReport([extraction.extraction_id]),
      },
    }
    await store.reserveRevisionPublication(revisionInput)
    await store.confirmRevisionPublication(revisionInput)
    assert.deepEqual(await store.createMemoryTreeRevision(revisionInput), {
      created: true,
      revision: 1,
      source: { kind: 'learning', operation_id: 'maintenance-1' },
    })
    assert.deepEqual(await store.createMemoryTreeRevision(revisionInput), {
      created: false,
      revision: 1,
      source: { kind: 'learning', operation_id: 'maintenance-1' },
    })

    assert.equal((await store.queries.getObservationBacklog()).pending_count, 0)
    assert.equal((await store.queries.getMemoryTree()).revision, 1)
    assert.equal(
      (await store.queries.getMemoryTreeRevision(1))?.predecessor_revision,
      null,
    )

    const history = await store.queries.listMemoryTreeRevisions(undefined, 10)
    assert.deepEqual(history.revisions, [
      await store.queries.getMemoryTreeRevision(1),
    ])
    assert.equal(history.next_before_revision, null)
    const consumed = await store.queries.listObservations(undefined, 10, {
      status: 'consumed',
      consumedRevision: 1,
    })
    assert.equal(consumed.observations[0]?.consumed_revision, 1)
    assert.deepEqual(
      (
        await store.queries.listObservations(undefined, 10, {
          status: 'pending',
        })
      ).observations,
      [],
    )

    await assert.rejects(
      store.createMemoryTreeRevision({
        expected_active_revision: 0,
        memory_tree_reference: artifact(
          'trees/operator-memory-tree.tar.zst',
          'e',
        ),
        source: {
          kind: 'manual',
          operation_id: 'operator-1',
          actor: { kind: 'user', id: 'reviewer@example.com' },
        },
      }),
      MemoryTreeRevisionConflictError,
    )

    const reorganizationInput = {
      expected_active_revision: 1,
      memory_tree_reference: artifact(
        'trees/reorganized-memory-tree.tar.zst',
        'f',
      ),
      source: {
        kind: 'reorganization' as const,
        operation_id: 'reorganization-1',
        trajectory_reference: artifact(
          'trajectories/memory-maintainer/reorganization.v1.jsonl.zst',
          'e',
        ),
        maintenance_report: reorganizationReport,
      },
    }
    for (const source of [
      {
        ...reorganizationInput.source,
        operation_id: revisionInput.source.operation_id,
      },
      {
        kind: 'manual' as const,
        operation_id: revisionInput.source.operation_id,
        actor: { kind: 'user' as const, id: 'reviewer@example.com' },
      },
    ]) {
      const conflictingInput = { ...reorganizationInput, source }
      await store.reserveRevisionPublication(conflictingInput)
      await store.confirmRevisionPublication(conflictingInput)
      await assert.rejects(
        store.createMemoryTreeRevision(conflictingInput),
        MemoryTreeRevisionConflictError,
      )
    }
    assert.equal((await store.queries.getMemoryTree()).revision, 1)

    await store.reserveRevisionPublication(reorganizationInput)
    await store.confirmRevisionPublication(reorganizationInput)
    assert.deepEqual(
      await store.createMemoryTreeRevision(reorganizationInput),
      {
        created: true,
        revision: 2,
        source: { kind: 'reorganization', operation_id: 'reorganization-1' },
      },
    )
    assert.deepEqual(
      await store.createMemoryTreeRevision(reorganizationInput),
      {
        created: false,
        revision: 2,
        source: { kind: 'reorganization', operation_id: 'reorganization-1' },
      },
    )
    const queries = new PostgresMemoryCatalogQueries(pool)
    const revision = await queries.getMemoryTreeRevision(2)
    assert.deepEqual(revision?.source, reorganizationInput.source)
    const reorganizationHistory = await queries.listMemoryTreeRevisions(
      undefined,
      10,
    )
    assert.deepEqual(reorganizationHistory.revisions[0], revision)

    const actor = { kind: 'user' as const, id: 'reviewer@example.com' }
    const pause = {
      operation_id: 'pause-automation',
      expected_generation: 0,
      actor,
    }
    const paused = await store.changeMemoryTreeAutomation('paused', pause)
    assert.equal(paused.automation.state, 'paused')
    assert.equal(
      (await store.createMemoryTreeRevision(revisionInput)).created,
      false,
    )
    assert.equal(
      (await store.createMemoryTreeRevision(reorganizationInput)).created,
      false,
    )

    const pendingExtraction = {
      ...extraction,
      extraction_id: 'extraction-while-paused',
    }
    const pendingPublication = {
      registration: pendingExtraction,
      summary: 'Observation while paused.',
    }
    await store.reserveExtractionPublication(pendingPublication)
    await store.confirmExtractionPublication(pendingPublication)
    assert.equal(await store.registerExtraction(pendingExtraction), true)
    for (const source of [
      {
        ...revisionInput.source,
        operation_id: 'paused-learning',
        extraction_ids: [pendingExtraction.extraction_id],
      },
      { ...reorganizationInput.source, operation_id: 'paused-reorganization' },
    ]) {
      const candidate = {
        ...reorganizationInput,
        expected_active_revision: 2,
        source,
      }
      await store.reserveRevisionPublication(candidate)
      await store.confirmRevisionPublication(candidate)
      await assert.rejects(
        store.createMemoryTreeRevision(candidate),
        AutomationPausedError,
      )
      assert.equal(
        (
          await store.listRevisionPublications(source.kind, source.operation_id)
        )[0]?.status,
        'abandoned',
      )
    }
    const manual = {
      expected_active_revision: 2,
      memory_tree_reference: artifact('trees/manual-while-paused.tar.zst', 'c'),
      source: {
        kind: 'manual' as const,
        operation_id: 'manual-while-paused',
        actor,
      },
    }
    await store.reserveRevisionPublication(manual)
    await store.confirmRevisionPublication(manual)
    assert.equal((await store.createMemoryTreeRevision(manual)).revision, 3)
    assert.equal((await store.queries.getObservationBacklog()).pending_count, 1)
    assert.equal(
      (
        await store.restoreMemoryTree({
          operation_id: 'restore-while-paused',
          expected_active_revision: 3,
          restored_revision: 1,
          actor,
        })
      ).active_revision,
      1,
    )
    const resumed = await store.changeMemoryTreeAutomation('enabled', {
      operation_id: 'resume-automation',
      expected_generation: 1,
      actor,
    })
    assert.equal(resumed.automation.state, 'enabled')
    assert.deepEqual(await store.changeMemoryTreeAutomation('paused', pause), {
      ...paused,
      created: false,
    })
    assert.deepEqual(
      await store.queries.getMemoryTreeAutomation(),
      resumed.automation,
    )
  } finally {
    await store.close()
    await administrator.query(`drop schema if exists ${schema} cascade`)
    await administrator.end()
  }
})
