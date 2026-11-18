// Every timestamp on the read surface must leave the store as the contract's ISO date-time
// string. node-pg parses a bare timestamptz column into a Date, and the JSON serializer hides
// the difference on the wire, so a row type that claims `string` for such a column type-checks
// and passes HTTP tests while the in-process value is still a Date. This file reads each surface
// through the store itself and checks the runtime value, which is where that drift shows up.
import crypto from 'node:crypto'
import { expect, test } from 'vitest'

import { Pool } from 'pg'

import { PostgresMemoryCatalogStore } from '../../src/catalog-store.js'
import type {
  Actor,
  ArtifactReference,
  ExtractionRegistration
} from '../../src/contract-types-generated.js'
import { learningReport } from '../maintenance-report.js'

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

function assertIsoTimestamp(value: unknown, field: string): void {
  expect(typeof value, `${field} must be a string`).toBe('string')
  expect(
    new Date(value as string).toISOString(),
    `${field} must be a canonical ISO date-time`
  ).toBe(value)
}

test('store reads return contract timestamps as ISO strings, not Dates', async () => {
  const schema = `memory_catalog_${crypto.randomUUID().replaceAll('-', '_')}`
  const administrator = new Pool({ connectionString: databaseUrl })
  await administrator.query(`create schema ${schema}`)
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`
  })
  const store = new PostgresMemoryCatalogStore('unused', pool)
  const extraction: ExtractionRegistration = {
    extraction_id: 'extraction-1',
    source_workflow: 'issue-review',
    source_run_id: 'run-1',
    source_unit_id: 'review',
    execution_archive_digest: `sha256:${'d'.repeat(64)}`,
    trajectory_reference: artifact('trajectories/memory-extractor/trajectory.v1.jsonl.zst', 'c'),
    observations: [{ observation_id: 'extraction-1', body_markdown: 'A fact.' }]
  }
  const actor: Actor = { kind: 'user', id: 'reviewer@example.com' }

  try {
    await store.initialize()
    const publication = { registration: extraction, summary: 'Observed.' }
    await store.reserveExtractionPublication(publication)
    await store.confirmExtractionPublication(publication)
    await store.registerExtraction(extraction)

    // Read while the observation is still pending, so the backlog has an oldest timestamp.
    const backlog = await store.queries.getObservationBacklog()
    assertIsoTimestamp(backlog.oldest_pending_created_at, 'backlog.oldest_pending_created_at')
    const stored = await store.queries.getExtraction(extraction.extraction_id)
    assertIsoTimestamp(stored?.created_at, 'extraction.created_at')
    const extractions = await store.queries.listExtractions(undefined, 10, {})
    assertIsoTimestamp(extractions.extractions[0]?.created_at, 'listExtractions.created_at')
    const observations = await store.queries.listObservations(undefined, 10, {})
    assertIsoTimestamp(observations.observations[0]?.created_at, 'observation.created_at')

    const versionInput = {
      expected_active_version: 0,
      memory_tree_reference: artifact('trees/memory-tree.v1.tar.zst', 'a'),
      source: {
        kind: 'learning' as const,
        operation_id: 'maintenance-1',
        observation_ids: [extraction.extraction_id],
        trajectory_reference: artifact(
          'trajectories/memory-maintainer/trajectory.v1.jsonl.zst',
          'b'
        ),
        maintenance_report: learningReport([extraction.extraction_id])
      }
    }
    await store.reserveVersionPublication(versionInput)
    await store.confirmVersionPublication(versionInput)
    await store.createMemoryTreeVersion(versionInput)
    assertIsoTimestamp(
      (await store.queries.getMemoryTreeVersion(1))?.created_at,
      'version.created_at'
    )
    const history = await store.queries.listMemoryTreeVersions(undefined, 10)
    assertIsoTimestamp(history.versions[0]?.created_at, 'listMemoryTreeVersions.created_at')

    const paused = await store.changeMemoryTreeAutomation('paused', {
      operation_id: 'pause-automation',
      expected_version: 0,
      actor
    })
    assertIsoTimestamp(paused.automation.changed_at, 'changed automation')
    const automation = await store.queries.getMemoryTreeAutomation()
    assertIsoTimestamp(automation.changed_at, 'automation.changed_at')
  } finally {
    await pool.end()
    await administrator.query(`drop schema if exists ${schema} cascade`)
    await administrator.end()
  }
})

for (const surface of ['extractions', 'observations'] as const) {
  test(`${surface} pagination preserves microseconds within one millisecond`, async () => {
    const schema = `memory_catalog_${crypto.randomUUID().replaceAll('-', '_')}`
    const administrator = new Pool({ connectionString: databaseUrl })
    await administrator.query(`create schema ${schema}`)
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`
    })
    const store = new PostgresMemoryCatalogStore('unused', pool)
    try {
      await store.initialize()
      for (const [id, fraction] of [
        ['newer', '123900'],
        ['older', '123800']
      ] as const) {
        const registration: ExtractionRegistration = {
          extraction_id: id,
          source_workflow: 'issue-review',
          source_run_id: id,
          source_unit_id: 'review',
          execution_archive_digest: `sha256:${'d'.repeat(64)}`,
          trajectory_reference: artifact(`trajectory-${id}`, 'c'),
          observations: [{ observation_id: id, body_markdown: 'A fact.' }]
        }
        const publication = { registration, summary: 'Observed.' }
        await store.reserveExtractionPublication(publication)
        await store.confirmExtractionPublication(publication)
        await store.registerExtraction(registration)
        await pool.query(`update ${surface} set created_at=$1 where extraction_id=$2`, [
          `2026-01-01T00:00:00.${fraction}Z`,
          id
        ])
      }
      const list = async (cursor: string | undefined) => {
        if (surface === 'extractions') {
          const page = await store.queries.listExtractions(cursor, 1, {})
          return {
            ids: page.extractions.map((row) => row.extraction_id),
            timestamps: page.extractions.map((row) => row.created_at),
            cursor: page.next_cursor
          }
        }
        const page = await store.queries.listObservations(cursor, 1, {})
        return {
          ids: page.observations.map((row) => row.observation_id),
          timestamps: page.observations.map((row) => row.created_at),
          cursor: page.next_cursor
        }
      }
      const first = await list(undefined)
      expect(first.ids).toEqual(['newer'])
      expect(first.timestamps).toEqual(['2026-01-01T00:00:00.123Z'])
      expect(first.cursor).toEqual(expect.any(String))
      const second = await list(first.cursor!)
      expect(second.ids).toEqual(['older'])
      expect(second.timestamps).toEqual(first.timestamps)
      expect(second.cursor).toBeNull()
    } finally {
      await pool.end()
      await administrator.query(`drop schema if exists ${schema} cascade`)
      await administrator.end()
    }
  })
}
