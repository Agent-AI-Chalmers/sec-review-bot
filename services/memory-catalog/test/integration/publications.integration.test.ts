import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import { Pool } from 'pg'
import {
  AutomationPausedError,
  PublicationAbandonedError,
  ExtractionConflictError,
  MemoryTreeVersionConflictError,
  PostgresMemoryCatalogStore
} from '../../src/catalog-store.js'
import type {
  ArtifactReference,
  ExtractionPublicationIntent
} from '../../src/contract-types-generated.js'
import { learningReport, reorganizationReport } from '../maintenance-report.js'

function artifact(character: string): ArtifactReference {
  return {
    uri: `s3://sec-review/memory/${character}`,
    digest: `sha256:${character.repeat(64)}`,
    media_type: 'application/zstd',
    size_bytes: 42
  }
}

test('publication recovery preserves intents and attachment transactions select one complete result', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL
  expect.assert(databaseUrl)
  const schema = `memory_publications_${crypto.randomUUID().replaceAll('-', '_')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`
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
        { observation_id: 'extract-1', body_markdown: 'Remember this.' }
      ]
    },
    summary: 'Produced observation.'
  }
  try {
    await store.initialize()
    expect((await store.reserveExtractionPublication(intent)).status).toBe(
      'reserved'
    )
    await expect(store.registerExtraction(intent.registration)).rejects.toThrow(
      ExtractionConflictError
    )
    await expect(
      store.reserveExtractionPublication({
        ...intent,
        summary: 'Changed summary.'
      })
    ).rejects.toThrow(ExtractionConflictError)
    expect(await store.listExtractionPublications('extract-1')).toStrictEqual([
      { intent, status: 'reserved' }
    ])
    await store.confirmExtractionPublication(intent)
    expect(await store.registerExtraction(intent.registration)).toBe(true)
    // A response-lost replay sees both the full intent and the authoritative attachment.
    expect(
      (await store.listExtractionPublications('extract-1'))[0]?.status
    ).toBe('selected')
    expect(await store.registerExtraction(intent.registration)).toBe(false)
    const alternative = {
      ...intent,
      registration: {
        ...intent.registration,
        trajectory_reference: artifact('b')
      }
    }
    await store.reserveExtractionPublication(alternative)
    await store.confirmExtractionPublication(alternative)
    await expect(
      store.registerExtraction(alternative.registration)
    ).rejects.toThrow(ExtractionConflictError)
    expect(
      (await store.listExtractionPublications('extract-1'))[1]?.status
    ).toBe('present')

    const version = {
      expected_active_version: 0,
      memory_tree_reference: artifact('c'),
      source: {
        kind: 'learning' as const,
        operation_id: 'maintain-1',
        observation_ids: ['extract-1'],
        trajectory_reference: artifact('e'),
        maintenance_report: learningReport(['extract-1'])
      }
    }
    await store.reserveVersionPublication(version)
    await expect(store.createMemoryTreeVersion(version)).rejects.toThrow(
      MemoryTreeVersionConflictError
    )
    await store.confirmVersionPublication(version)
    const competing = { ...version, memory_tree_reference: artifact('f') }
    await store.reserveVersionPublication(competing)
    await store.confirmVersionPublication(competing)
    const outcomes = await Promise.allSettled([
      store.createMemoryTreeVersion(version),
      store.createMemoryTreeVersion(competing)
    ])
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled')
    ).toHaveLength(1)
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    expect.assert(
      failed?.status === 'rejected' &&
        failed.reason instanceof MemoryTreeVersionConflictError
    )
    expect((await store.queries.getMemoryTree()).version).toBe(1)
    expect((await store.queries.getObservationBacklog()).pending_count).toBe(0)
    const publications = await store.listVersionPublications(
      'learning',
      'maintain-1'
    )
    expect(publications[0]?.status).toBe('selected')
    expect(publications[1]?.status).toBe('present')
    const selectedPublication = publications[0]
    expect.assert(selectedPublication)
    const selected = selectedPublication.intent
    expect.assert(selected.source.kind === 'learning')
    expect(
      (
        await store.createMemoryTreeVersion({
          ...selected,
          source: selected.source
        })
      ).created
    ).toBe(false)

    const operator = {
      expected_active_version: 0,
      memory_tree_reference: artifact('a'),
      source: {
        kind: 'manual' as const,
        operation_id: 'edit-1',
        actor: { kind: 'service' as const, id: 'operator' }
      }
    }
    await store.reserveVersionPublication(operator)
    await store.confirmVersionPublication(operator)
    await expect(store.createMemoryTreeVersion(operator)).rejects.toThrow(
      MemoryTreeVersionConflictError
    )
    expect(
      (await store.listVersionPublications('manual', 'edit-1'))[0]?.status,
      'CAS failure rolls back candidate selection'
    ).toBe('present')
    expect((await store.queries.getMemoryTree()).version).toBe(1)

    // Different kinds must serialize on the same globally unique operation ID.
    const candidates = [
      {
        expected_active_version: 1,
        memory_tree_reference: artifact('a'),
        source: {
          kind: 'reorganization' as const,
          operation_id: 'shared-operation',
          trajectory_reference: artifact('e'),
          maintenance_report: reorganizationReport
        }
      },
      {
        ...operator,
        expected_active_version: 1,
        source: { ...operator.source, operation_id: 'shared-operation' }
      }
    ]
    for (const candidate of candidates) {
      await store.reserveVersionPublication(candidate)
      await store.confirmVersionPublication(candidate)
    }
    const concurrent = await Promise.allSettled(
      candidates.map((candidate) => store.createMemoryTreeVersion(candidate))
    )
    expect(
      concurrent.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1)
    const rejected = concurrent.find((result) => result.status === 'rejected')
    expect.assert(
      rejected?.status === 'rejected' &&
        rejected.reason instanceof MemoryTreeVersionConflictError
    )
    const recorded = await Promise.all(
      candidates.map((candidate) =>
        store.listVersionPublications(candidate.source.kind, 'shared-operation')
      )
    )
    expect(
      recorded.flat().filter((publication) => publication.status === 'selected')
    ).toHaveLength(1)
    expect((await store.queries.getMemoryTree()).version).toBe(2)

    // Preparation cleanup is idempotent and never changes selected publications.
    await store.abandonVersionPublications({
      kind: 'learning',
      operation_id: 'maintain-1'
    })
    expect(
      (await store.listVersionPublications('learning', 'maintain-1'))[0]?.status
    ).toBe('selected')
    expect(
      (
        await store.createMemoryTreeVersion({
          ...selected,
          source: selected.source
        })
      ).created
    ).toBe(false)
    const prepared = {
      expected_active_version: 2,
      memory_tree_reference: artifact('c'),
      source: {
        kind: 'reorganization' as const,
        operation_id: 'prepared',
        trajectory_reference: artifact('e'),
        maintenance_report: reorganizationReport
      }
    }
    await store.reserveVersionPublication(prepared)
    const other = { ...prepared, memory_tree_reference: artifact('f') }
    await store.reserveVersionPublication(other)
    await store.confirmVersionPublication(other)
    expect(
      await store.abandonVersionPublications({
        kind: 'reorganization',
        operation_id: 'prepared'
      })
    ).toHaveLength(2)
    expect(
      await store.abandonVersionPublications({
        kind: 'reorganization',
        operation_id: 'prepared'
      })
    ).toStrictEqual([])
    expect((await store.confirmVersionPublication(prepared)).status).toBe(
      'abandoned'
    )
    expect((await store.reserveVersionPublication(prepared)).status).toBe(
      'abandoned'
    )
    await expect(store.createMemoryTreeVersion(prepared)).rejects.toThrow(
      PublicationAbandonedError
    )

    // A paused commit persists abandonment despite returning an HTTP conflict.
    const pausedCandidate = {
      ...prepared,
      source: { ...prepared.source, operation_id: 'paused-candidate' }
    }
    await store.reserveVersionPublication(pausedCandidate)
    await store.confirmVersionPublication(pausedCandidate)
    await pool.query("update memory_tree_automation set state='paused'")
    await expect(
      store.createMemoryTreeVersion(pausedCandidate)
    ).rejects.toThrow(AutomationPausedError)
    expect(
      (
        await store.listVersionPublications(
          'reorganization',
          'paused-candidate'
        )
      )[0]?.status
    ).toBe('abandoned')
    expect((await store.queries.getMemoryTree()).version).toBe(2)
    // The two ways a candidate is abandoned are recorded apart, so an operator can tell a paused
    // commit from a worker's cleanup without reconstructing it from logs.
    const reasons = await pool.query<{
      operation_id: string
      reasons: string[]
    }>(
      `select operation_id, array_agg(distinct abandon_reason) as reasons
       from memory_version_publications
       where operation_id in ('prepared','paused-candidate')
       group by operation_id order by operation_id`
    )
    expect(reasons.rows).toStrictEqual([
      { operation_id: 'paused-candidate', reasons: ['automation_paused'] },
      { operation_id: 'prepared', reasons: ['worker_cleanup'] }
    ])
    await pool.query("update memory_tree_automation set state='enabled'")
    // A response-lost retry after resume must not submit the abandoned candidate.
    await expect(
      store.createMemoryTreeVersion(pausedCandidate)
    ).rejects.toThrow(PublicationAbandonedError)

    // Commit and cleanup serialize: either a selected version survives or its candidate is abandoned.
    const racing = {
      ...prepared,
      source: { ...prepared.source, operation_id: 'racing' }
    }
    await store.reserveVersionPublication(racing)
    await store.confirmVersionPublication(racing)
    const race = await Promise.allSettled([
      store.createMemoryTreeVersion(racing),
      store.abandonVersionPublications({
        kind: 'reorganization',
        operation_id: 'racing'
      })
    ])
    const cleanup = race[1]
    expect.assert(
      cleanup?.status === 'fulfilled' && Array.isArray(cleanup.value)
    )
    const status = (
      await store.listVersionPublications('reorganization', 'racing')
    )[0]?.status
    if (cleanup.value.length) {
      expect(status).toBe('abandoned')
      expect((await store.queries.getMemoryTree()).version).toBe(2)
      expect(race[0]?.status).toBe('rejected')
    } else {
      expect(status).toBe('selected')
      expect((await store.queries.getMemoryTree()).version).toBe(3)
      expect(race[0]?.status).toBe('fulfilled')
    }
    // Abandonment is publication-scoped, not an operation-level ban. A late
    // attempt may reserve a new candidate after an abandon; only explicit
    // cleanup or a paused commit can abandon that new publication.
    const lateOwner = {
      kind: 'reorganization' as const,
      operation_id: 'late-publication'
    }
    expect(await store.abandonVersionPublications(lateOwner)).toStrictEqual([])
    const latePublication = {
      expected_active_version: (await store.queries.getMemoryTree()).version,
      memory_tree_reference: artifact('a'),
      source: {
        kind: 'reorganization' as const,
        operation_id: 'late-publication',
        trajectory_reference: artifact('b'),
        maintenance_report: reorganizationReport
      }
    }
    expect(
      (await store.reserveVersionPublication(latePublication)).status
    ).toBe('reserved')
    expect(
      (await store.confirmVersionPublication(latePublication)).status
    ).toBe('present')
    expect(
      (
        await store.listVersionPublications(
          'reorganization',
          'late-publication'
        )
      )[0]?.status
    ).toBe('present')
    await store.abandonVersionPublications(lateOwner)
    const laterPublication = {
      ...latePublication,
      memory_tree_reference: artifact('c')
    }
    expect(
      (await store.reserveVersionPublication(laterPublication)).status
    ).toBe('reserved')
    expect(
      (await store.confirmVersionPublication(laterPublication)).status
    ).toBe('present')
    const latePublications = await store.listVersionPublications(
      lateOwner.kind,
      lateOwner.operation_id
    )
    expect(latePublications).toHaveLength(2)
    expect(
      latePublications.find(
        ({ intent }) =>
          intent.memory_tree_reference.digest ===
          latePublication.memory_tree_reference.digest
      )?.status
    ).toBe('abandoned')
    expect(
      latePublications.find(
        ({ intent }) =>
          intent.memory_tree_reference.digest ===
          laterPublication.memory_tree_reference.digest
      )?.status
    ).toBe('present')
  } finally {
    await store.close()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
