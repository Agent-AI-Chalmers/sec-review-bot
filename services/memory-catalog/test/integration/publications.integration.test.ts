import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import {
  AutomationPausedError,
  PublicationAbandonedError,
  ExtractionConflictError,
  MemoryTreeVersionConflictError,
  PostgresMemoryCatalogStore,
} from '../../src/catalog-store.js'
import type {
  ArtifactReference,
  ExtractionPublicationIntent,
} from '../../src/contract-types-generated.js'
import { learningReport, reorganizationReport } from '../maintenance-report.js'

function artifact(character: string): ArtifactReference {
  return {
    uri: `s3://sec-review/memory/${character}`,
    digest: `sha256:${character.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 42,
  }
}

await test('publication recovery preserves intents and attachment transactions select one complete result', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL
  assert(databaseUrl)
  const schema = `memory_publications_${crypto.randomUUID().replaceAll('-', '_')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  })
  const store = new PostgresMemoryCatalogStore('unused', pool)
  const intent: ExtractionPublicationIntent = {
    registration: {
      extraction_id: 'extract-1',
      source_workflow: 'issue-review',
      source_run_id: 'run-1',
      source_unit_id: 'review',
      execution_archive_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: artifact('a'),
      observations: [
        { observation_id: 'extract-1', body_markdown: 'Remember this.' },
      ],
    },
    summary: 'Produced observation.',
  }
  try {
    await store.initialize()
    assert.equal(
      (await store.reserveExtractionPublication(intent)).status,
      'reserved',
    )
    await assert.rejects(
      store.registerExtraction(intent.registration),
      ExtractionConflictError,
    )
    await assert.rejects(
      store.reserveExtractionPublication({
        ...intent,
        summary: 'Changed summary.',
      }),
      ExtractionConflictError,
    )
    assert.deepEqual(await store.listExtractionPublications('extract-1'), [
      { intent, status: 'reserved' },
    ])
    await store.confirmExtractionPublication(intent)
    assert.equal(await store.registerExtraction(intent.registration), true)
    // A response-lost replay sees both the full intent and the authoritative attachment.
    assert.equal(
      (await store.listExtractionPublications('extract-1'))[0]?.status,
      'selected',
    )
    assert.equal(await store.registerExtraction(intent.registration), false)
    const alternative = {
      ...intent,
      registration: {
        ...intent.registration,
        trajectory_reference: artifact('b'),
      },
    }
    await store.reserveExtractionPublication(alternative)
    await store.confirmExtractionPublication(alternative)
    await assert.rejects(
      store.registerExtraction(alternative.registration),
      ExtractionConflictError,
    )
    assert.equal(
      (await store.listExtractionPublications('extract-1'))[1]?.status,
      'present',
    )

    const version = {
      expected_active_version: 0,
      memory_tree_reference: artifact('c'),
      source: {
        kind: 'learning' as const,
        operation_id: 'maintain-1',
        observation_ids: ['extract-1'],
        trajectory_reference: artifact('e'),
        maintenance_report: learningReport(['extract-1']),
      },
    }
    await store.reserveVersionPublication(version)
    await assert.rejects(
      store.createMemoryTreeVersion(version),
      MemoryTreeVersionConflictError,
    )
    await store.confirmVersionPublication(version)
    const competing = { ...version, memory_tree_reference: artifact('f') }
    await store.reserveVersionPublication(competing)
    await store.confirmVersionPublication(competing)
    const outcomes = await Promise.allSettled([
      store.createMemoryTreeVersion(version),
      store.createMemoryTreeVersion(competing),
    ])
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    )
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    assert(
      failed?.status === 'rejected' &&
        failed.reason instanceof MemoryTreeVersionConflictError,
    )
    assert.equal((await store.queries.getMemoryTree()).version, 1)
    assert.equal((await store.queries.getObservationBacklog()).pending_count, 0)
    const publications = await store.listVersionPublications(
      'learning',
      'maintain-1',
    )
    assert.equal(publications[0]?.status, 'selected')
    assert.equal(publications[1]?.status, 'present')
    const selected = publications[0].intent
    assert(selected.source.kind === 'learning')
    assert.equal(
      (
        await store.createMemoryTreeVersion({
          ...selected,
          source: selected.source,
        })
      ).created,
      false,
    )

    const operator = {
      expected_active_version: 0,
      memory_tree_reference: artifact('a'),
      source: {
        kind: 'manual' as const,
        operation_id: 'edit-1',
        actor: { kind: 'service' as const, id: 'operator' },
      },
    }
    await store.reserveVersionPublication(operator)
    await store.confirmVersionPublication(operator)
    await assert.rejects(
      store.createMemoryTreeVersion(operator),
      MemoryTreeVersionConflictError,
    )
    assert.equal(
      (await store.listVersionPublications('manual', 'edit-1'))[0]?.status,
      'present',
      'CAS failure rolls back candidate selection',
    )
    assert.equal((await store.queries.getMemoryTree()).version, 1)

    // Different kinds must serialize on the same globally unique operation ID.
    const candidates = [
      {
        expected_active_version: 1,
        memory_tree_reference: artifact('a'),
        source: {
          kind: 'reorganization' as const,
          operation_id: 'shared-operation',
          trajectory_reference: artifact('e'),
          maintenance_report: reorganizationReport,
        },
      },
      {
        ...operator,
        expected_active_version: 1,
        source: { ...operator.source, operation_id: 'shared-operation' },
      },
    ]
    for (const candidate of candidates) {
      await store.reserveVersionPublication(candidate)
      await store.confirmVersionPublication(candidate)
    }
    const concurrent = await Promise.allSettled(
      candidates.map((candidate) => store.createMemoryTreeVersion(candidate)),
    )
    assert.equal(
      concurrent.filter((result) => result.status === 'fulfilled').length,
      1,
    )
    const rejected = concurrent.find((result) => result.status === 'rejected')
    assert(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof MemoryTreeVersionConflictError,
    )
    const recorded = await Promise.all(
      candidates.map((candidate) =>
        store.listVersionPublications(
          candidate.source.kind,
          'shared-operation',
        ),
      ),
    )
    assert.equal(
      recorded.flat().filter((publication) => publication.status === 'selected')
        .length,
      1,
    )
    assert.equal((await store.queries.getMemoryTree()).version, 2)

    // Preparation cleanup is idempotent and never changes selected publications.
    await store.abandonVersionPublications({
      kind: 'learning',
      operation_id: 'maintain-1',
    })
    assert.equal(
      (await store.listVersionPublications('learning', 'maintain-1'))[0]
        ?.status,
      'selected',
    )
    assert.equal(
      (
        await store.createMemoryTreeVersion({
          ...selected,
          source: selected.source,
        })
      ).created,
      false,
    )
    const prepared = {
      expected_active_version: 2,
      memory_tree_reference: artifact('c'),
      source: {
        kind: 'reorganization' as const,
        operation_id: 'prepared',
        trajectory_reference: artifact('e'),
        maintenance_report: reorganizationReport,
      },
    }
    await store.reserveVersionPublication(prepared)
    const other = { ...prepared, memory_tree_reference: artifact('f') }
    await store.reserveVersionPublication(other)
    await store.confirmVersionPublication(other)
    assert.equal(
      (
        await store.abandonVersionPublications({
          kind: 'reorganization',
          operation_id: 'prepared',
        })
      ).length,
      2,
    )
    assert.deepEqual(
      await store.abandonVersionPublications({
        kind: 'reorganization',
        operation_id: 'prepared',
      }),
      [],
    )
    assert.equal(
      (await store.confirmVersionPublication(prepared)).status,
      'abandoned',
    )
    assert.equal(
      (await store.reserveVersionPublication(prepared)).status,
      'abandoned',
    )
    await assert.rejects(
      store.createMemoryTreeVersion(prepared),
      PublicationAbandonedError,
    )

    // A paused commit persists abandonment despite returning an HTTP conflict.
    const pausedCandidate = {
      ...prepared,
      source: { ...prepared.source, operation_id: 'paused-candidate' },
    }
    await store.reserveVersionPublication(pausedCandidate)
    await store.confirmVersionPublication(pausedCandidate)
    await pool.query("update memory_tree_automation set state='paused'")
    await assert.rejects(
      store.createMemoryTreeVersion(pausedCandidate),
      AutomationPausedError,
    )
    assert.equal(
      (
        await store.listVersionPublications(
          'reorganization',
          'paused-candidate',
        )
      )[0]?.status,
      'abandoned',
    )
    assert.equal((await store.queries.getMemoryTree()).version, 2)
    // The two ways a candidate is abandoned are recorded apart, so an operator can tell a paused
    // commit from a worker's cleanup without reconstructing it from logs.
    const reasons = await pool.query<{
      operation_id: string
      reasons: string[]
    }>(
      `select operation_id, array_agg(distinct abandon_reason) as reasons
       from memory_version_publications
       where operation_id in ('prepared','paused-candidate')
       group by operation_id order by operation_id`,
    )
    assert.deepEqual(reasons.rows, [
      { operation_id: 'paused-candidate', reasons: ['automation_paused'] },
      { operation_id: 'prepared', reasons: ['worker_cleanup'] },
    ])
    await pool.query("update memory_tree_automation set state='enabled'")
    // A response-lost retry after resume must not submit the abandoned candidate.
    await assert.rejects(
      store.createMemoryTreeVersion(pausedCandidate),
      PublicationAbandonedError,
    )

    // Commit and cleanup serialize: either a selected version survives or its candidate is abandoned.
    const racing = {
      ...prepared,
      source: { ...prepared.source, operation_id: 'racing' },
    }
    await store.reserveVersionPublication(racing)
    await store.confirmVersionPublication(racing)
    const race = await Promise.allSettled([
      store.createMemoryTreeVersion(racing),
      store.abandonVersionPublications({
        kind: 'reorganization',
        operation_id: 'racing',
      }),
    ])
    const cleanup = race[1]
    assert(cleanup?.status === 'fulfilled' && Array.isArray(cleanup.value))
    const status = (
      await store.listVersionPublications('reorganization', 'racing')
    )[0]?.status
    if (cleanup.value.length) {
      assert.equal(status, 'abandoned')
      assert.equal((await store.queries.getMemoryTree()).version, 2)
      assert.equal(race[0]?.status, 'rejected')
    } else {
      assert.equal(status, 'selected')
      assert.equal((await store.queries.getMemoryTree()).version, 3)
      assert.equal(race[0]?.status, 'fulfilled')
    }
    // Abandonment is publication-scoped, not an operation-level ban. A late
    // attempt may reserve a new candidate after an abandon; only explicit
    // cleanup or a paused commit can abandon that new publication.
    const lateOwner = {
      kind: 'reorganization' as const,
      operation_id: 'late-publication',
    }
    assert.deepEqual(await store.abandonVersionPublications(lateOwner), [])
    const latePublication = {
      expected_active_version: (await store.queries.getMemoryTree()).version,
      memory_tree_reference: artifact('a'),
      source: {
        kind: 'reorganization' as const,
        operation_id: 'late-publication',
        trajectory_reference: artifact('b'),
        maintenance_report: reorganizationReport,
      },
    }
    assert.equal(
      (await store.reserveVersionPublication(latePublication)).status,
      'reserved',
    )
    assert.equal(
      (await store.confirmVersionPublication(latePublication)).status,
      'present',
    )
    assert.equal(
      (
        await store.listVersionPublications(
          'reorganization',
          'late-publication',
        )
      )[0]?.status,
      'present',
    )
    await store.abandonVersionPublications(lateOwner)
    const laterPublication = {
      ...latePublication,
      memory_tree_reference: artifact('c'),
    }
    assert.equal(
      (await store.reserveVersionPublication(laterPublication)).status,
      'reserved',
    )
    assert.equal(
      (await store.confirmVersionPublication(laterPublication)).status,
      'present',
    )
    const latePublications = await store.listVersionPublications(
      lateOwner.kind,
      lateOwner.operation_id,
    )
    assert.equal(latePublications.length, 2)
    assert.equal(
      latePublications.find(
        ({ intent }) =>
          intent.memory_tree_reference.digest ===
          latePublication.memory_tree_reference.digest,
      )?.status,
      'abandoned',
    )
    assert.equal(
      latePublications.find(
        ({ intent }) =>
          intent.memory_tree_reference.digest ===
          laterPublication.memory_tree_reference.digest,
      )?.status,
      'present',
    )
  } finally {
    await store.close()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
