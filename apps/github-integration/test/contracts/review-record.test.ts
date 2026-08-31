import assert from 'node:assert/strict'
import test from 'node:test'

import { contractFixture, contractFixtureManifest } from '../contract-fixtures.js'
import { parseReviewRecord } from '../../reviews/review-record.js'

interface FixtureManifest {
  schema_fixtures: Record<string, string>
}

interface ReviewRecordFixture {
  analysis: Record<string, unknown>
  mitigation: Record<string, unknown> & {
    changed_files: string[]
    file_changes: unknown[]
  }
  verification: Record<string, unknown>
  cvss: unknown
}

function reviewRecordFixtureNames (): string[] {
  const manifest = contractFixtureManifest('v4') as FixtureManifest
  return Object.entries(manifest.schema_fixtures)
    .filter(([, schemaName]) => schemaName === 'review-record.schema.json')
    .map(([fixtureName]) => fixtureName)
    .sort()
}

function validReviewRecord (): ReviewRecordFixture {
  return {
    analysis: {
      verdict: 'confirmed-vulnerability',
      overview: 'Unsafe path handling.',
      narratives: []
    },
    mitigation: {
      overview: null,
      changed_files: [],
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: null,
      review_target_claim: null,
      validation_level: null,
      patch_coverage: null,
      regression_status: null,
      resolution_next_step: null,
      patch_findings: [],
      verification_findings: [],
      residual_risks: []
    },
    cvss: null
  }
}

test('parseReviewRecord accepts a complete v4 review_record', () => {
  const record = parseReviewRecord(validReviewRecord())

  assert.equal(record.analysis.verdict, 'confirmed-vulnerability')
  assert.deepEqual(record.mitigation.changed_files, [])
})

test('parseReviewRecord accepts the shared v4 review_record fixture', () => {
  const record = parseReviewRecord(contractFixture('v4', 'review-record.json'))

  assert.equal(record.analysis.verdict, 'confirmed-vulnerability')
  assert.equal(record.verification.patch_coverage, 'full')
  assert.equal(record.cvss?.severity, 'medium')
})

test('parseReviewRecord accepts the shared v4 deleted-file review_record fixture', () => {
  const record = parseReviewRecord(contractFixture('v4', 'review-record-deleted-file.json'))

  assert.equal(record.analysis.verdict, 'confirmed-defect')
  assert.equal(record.mitigation.file_changes.at(0)?.status, 'deleted')
  assert.equal(record.cvss?.outcome, 'not-scored')
})

test('parseReviewRecord accepts every shared v4 review_record schema fixture', () => {
  for (const fixtureName of reviewRecordFixtureNames()) {
    assert.doesNotThrow(
      () => parseReviewRecord(contractFixture('v4', fixtureName)),
      fixtureName
    )
  }
})

test('parseReviewRecord accepts schema-valid upsert file changes', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: 'src/server.ts',
      status: 'upsert',
      content: 'export const ok = true\n',
      content_encoding: 'utf-8',
      mode: '100644'
    }
  ]

  assert.equal(parseReviewRecord(record).mitigation.file_changes.at(0)?.status, 'upsert')
})

test('parseReviewRecord rejects deleted file changes with content', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: 'src/server.ts',
      status: 'deleted',
      content: ''
    }
  ]

  assert.throws(
    () => parseReviewRecord(record),
    /mitigation\.file_changes\[0].*unsupported field "content"/
  )
})

test('parseReviewRecord rejects upsert file changes without content encoding', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: 'src/server.ts',
      status: 'upsert',
      content: ''
    }
  ]

  assert.throws(
    () => parseReviewRecord(record),
    /mitigation\.file_changes\[0]\.content_encoding is required/
  )
})

test('parseReviewRecord rejects file changes with unsupported fields', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: 'src/server.ts',
      status: 'upsert',
      content: '',
      content_encoding: 'utf-8',
      sha: 'abc123'
    }
  ]

  assert.throws(
    () => parseReviewRecord(record),
    /mitigation\.file_changes\[0].*unsupported field "sha"/
  )
})

test('parseReviewRecord rejects unsafe file change paths', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: '../server.ts',
      status: 'deleted'
    }
  ]

  assert.throws(
    () => parseReviewRecord(record),
    /Unsafe repository file path/
  )
})

test('parseReviewRecord rejects file change paths with surrounding whitespace', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: ' src/server.ts ',
      status: 'deleted'
    }
  ]

  assert.throws(
    () => parseReviewRecord(record),
    /mitigation\.file_changes\[0]\.path must not include leading or trailing whitespace/
  )
})

test('parseReviewRecord rejects unsupported public fields', () => {
  const record = validReviewRecord()
  record.analysis.status = 'error'

  assert.throws(
    () => parseReviewRecord(record),
    /analysis has unsupported field "status"/
  )
})

test('parseReviewRecord rejects invalid cvss field types', () => {
  const record = validReviewRecord()
  record.cvss = {
    outcome: 'scored',
    base_score: '8.1',
    severity: 'high',
    vector: 'CVSS:4.0/AV:N',
    overview: null,
    not_scored_reason: null
  }

  assert.throws(
    () => parseReviewRecord(record),
    /cvss\.base_score must be a number from 0 to 10 or null/
  )
})

test('parseReviewRecord rejects malformed v4 review_record', () => {
  assert.throws(
    () => parseReviewRecord({
      analysis: {
        verdict: 'confirmed-vulnerability',
        overview: 'Unsafe path handling.',
        narratives: []
      }
    }),
    /mitigation is required/
  )
})

test('parseReviewRecord rejects unknown public enum values', () => {
  const record = validReviewRecord()
  record.verification.patch_coverage = 'future-coverage'

  assert.throws(
    () => parseReviewRecord(record),
    /verification\.patch_coverage has unknown value/
  )
})

test('parseReviewRecord rejects removed public status fields', () => {
  const record = validReviewRecord()
  Object.assign(record.mitigation, { status: 'error' })

  assert.throws(
    () => parseReviewRecord(record),
    /mitigation has unsupported field "status"/
  )
})
