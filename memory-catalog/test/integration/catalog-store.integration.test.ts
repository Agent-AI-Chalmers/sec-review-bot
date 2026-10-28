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
  ExtractionRegistration,
} from '../../src/contract-types-generated.js'

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
    diagnostic_bundle_digest: `sha256:${'d'.repeat(64)}`,
    transcript_reference: artifact(
      'transcripts/memory-extractor/transcript.v1.jsonl.zst',
      'c',
    ),
    observation: { body_markdown: observationBody },
  }

  try {
    await store.initialize()

    assert.equal(await store.registerExtraction(extraction), true)
    assert.equal(await store.registerExtraction(extraction), false)
    await assert.rejects(
      store.registerExtraction({
        ...extraction,
        observation: { body_markdown: 'Conflicting observation.' },
      }),
      ExtractionConflictError,
    )

    const stored = await store.getExtraction(extraction.extraction_id)
    assert.equal(
      stored?.observation?.body_markdown,
      extraction.observation?.body_markdown,
    )
    assert.deepEqual(
      stored?.transcript_reference,
      extraction.transcript_reference,
    )

    const maintenanceInput = await store.getMaintenanceInput(10)
    assert.equal(maintenanceInput?.expected_active_revision, 0)
    assert.deepEqual(maintenanceInput?.observations, [
      {
        extraction_id: extraction.extraction_id,
        body_markdown: observationBody,
      },
    ])

    const revisionInput = {
      expected_active_revision: 0,
      memory_tree_reference: artifact('trees/memory-tree.v1.tar.zst', 'a'),
      source: {
        kind: 'maintenance' as const,
        maintenance_id: 'maintenance-1',
        extraction_ids: [extraction.extraction_id],
        transcript_reference: artifact(
          'transcripts/memory-maintainer/transcript.v1.jsonl.zst',
          'b',
        ),
      },
    }
    assert.deepEqual(await store.createMemoryTreeRevision(revisionInput), {
      created: true,
      revision: 1,
      source: { kind: 'maintenance', maintenance_id: 'maintenance-1' },
    })
    assert.deepEqual(await store.createMemoryTreeRevision(revisionInput), {
      created: false,
      revision: 1,
      source: { kind: 'maintenance', maintenance_id: 'maintenance-1' },
    })

    assert.equal((await store.getObservationBacklog()).pending_count, 0)
    assert.equal((await store.getMemoryTree()).revision, 1)
    assert.equal(
      (await store.getMemoryTreeRevision(1))?.predecessor_revision,
      null,
    )

    await assert.rejects(
      store.createMemoryTreeRevision({
        expected_active_revision: 0,
        memory_tree_reference: artifact(
          'trees/operator-memory-tree.tar.zst',
          'e',
        ),
        source: {
          kind: 'operator',
          operation_id: 'operator-1',
          actor: { kind: 'user', id: 'reviewer@example.com' },
        },
      }),
      MemoryTreeRevisionConflictError,
    )
  } finally {
    await store.close()
    await administrator.query(`drop schema if exists ${schema} cascade`)
    await administrator.end()
  }
})
