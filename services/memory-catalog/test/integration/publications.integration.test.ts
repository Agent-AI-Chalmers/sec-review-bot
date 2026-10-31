import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import {
  ExtractionConflictError,
  MemoryTreeRevisionConflictError,
  PostgresMemoryCatalogStore,
} from '../../src/catalog-store.js'
import type {
  ArtifactReference,
  ExtractionPublicationIntent,
} from '../../src/contract-types-generated.js'

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
      diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
      trajectory_reference: artifact('a'),
      observation: { body_markdown: 'Remember this.' },
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

    const revision = {
      expected_active_revision: 0,
      memory_tree_reference: artifact('c'),
      source: {
        kind: 'maintenance' as const,
        maintenance_id: 'maintain-1',
        extraction_ids: ['extract-1'],
        trajectory_reference: artifact('e'),
      },
    }
    await store.reserveRevisionPublication(revision)
    await assert.rejects(
      store.createMemoryTreeRevision(revision),
      MemoryTreeRevisionConflictError,
    )
    await store.confirmRevisionPublication(revision)
    const competing = { ...revision, memory_tree_reference: artifact('f') }
    await store.reserveRevisionPublication(competing)
    await store.confirmRevisionPublication(competing)
    const outcomes = await Promise.allSettled([
      store.createMemoryTreeRevision(revision),
      store.createMemoryTreeRevision(competing),
    ])
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    )
    const failed = outcomes.find((outcome) => outcome.status === 'rejected')
    assert(
      failed?.status === 'rejected' &&
        failed.reason instanceof MemoryTreeRevisionConflictError,
    )
    assert.equal((await store.queries.getMemoryTree()).revision, 1)
    assert.equal((await store.queries.getObservationBacklog()).pending_count, 0)
    const publications = await store.listRevisionPublications(
      'maintenance',
      'maintain-1',
    )
    assert.equal(publications[0]?.status, 'selected')
    assert.equal(publications[1]?.status, 'present')
    const selected = publications[0].intent
    assert(selected.source.kind === 'maintenance')
    assert.equal(
      (
        await store.createMemoryTreeRevision({
          ...selected,
          source: selected.source,
        })
      ).created,
      false,
    )

    const operator = {
      expected_active_revision: 0,
      memory_tree_reference: artifact('a'),
      source: {
        kind: 'operator' as const,
        operation_id: 'edit-1',
        actor: { kind: 'service' as const, id: 'operator' },
      },
    }
    await store.reserveRevisionPublication(operator)
    await store.confirmRevisionPublication(operator)
    await assert.rejects(
      store.createMemoryTreeRevision(operator),
      MemoryTreeRevisionConflictError,
    )
    assert.equal(
      (await store.listRevisionPublications('operator', 'edit-1'))[0]?.status,
      'present',
      'CAS failure rolls back candidate selection',
    )
    assert.equal((await store.queries.getMemoryTree()).revision, 1)
  } finally {
    await store.close()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
