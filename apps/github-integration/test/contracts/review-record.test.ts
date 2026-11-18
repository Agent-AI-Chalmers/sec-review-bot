import { expect, test } from 'vitest'

import { contractFixture, contractFixtureManifest } from '../contract-fixtures.js'
import { parseReviewRecord } from '../../src/reviews/review-record.js'

interface FixtureManifest {
  schema_fixtures: Record<string, string>
}

interface ReviewRecordFixture {
  analysis: Record<string, unknown>
  mitigation: Record<string, unknown> & {
    file_changes: unknown[]
  }
  verification: Record<string, unknown>
  cvss: unknown
}

function reviewRecordFixtureNames(): string[] {
  const manifest = contractFixtureManifest() as FixtureManifest
  return Object.entries(manifest.schema_fixtures)
    .filter(([, schemaName]) => schemaName === 'review-record.schema.json')
    .map(([fixtureName]) => fixtureName)
    .sort()
}

function validReviewRecord(): ReviewRecordFixture {
  return {
    analysis: {
      verdict: 'confirmed-vulnerability',
      overview: 'Unsafe path handling.',
      narratives: []
    },
    mitigation: {
      overview: null,
      file_changes: [],
      patch_diff: null
    },
    verification: {
      overview: null,
      target_claim: null,
      validation_level: null,
      coverage: null,
      regression: null,
      next_step: null,
      findings: [],
      evidence: [],
      residual_risks: []
    },
    cvss: null
  }
}

test('parseReviewRecord accepts a complete v1 review_record', () => {
  const record = parseReviewRecord(validReviewRecord())

  expect(record.analysis.verdict).toBe('confirmed-vulnerability')
  expect(record.mitigation.file_changes).toStrictEqual([])
})

test('parseReviewRecord accepts the shared v1 review_record fixture', () => {
  const record = parseReviewRecord(contractFixture('review-record.json'))

  expect(record.analysis.verdict).toBe('confirmed-vulnerability')
  expect(record.verification.coverage).toBe('full')
  expect(record.cvss?.severity).toBe('medium')
})

test('parseReviewRecord accepts the shared v1 deleted-file review_record fixture', () => {
  const record = parseReviewRecord(contractFixture('review-record-deleted-file.json'))

  expect(record.analysis.verdict).toBe('confirmed-defect')
  expect(record.mitigation.file_changes.at(0)?.status).toBe('deleted')
  expect(record.cvss?.outcome).toBe('not-scored')
})

test('parseReviewRecord accepts every shared v1 review_record schema fixture', () => {
  for (const fixtureName of reviewRecordFixtureNames()) {
    expect(() => parseReviewRecord(contractFixture(fixtureName)), fixtureName).not.toThrow()
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

  expect(parseReviewRecord(record).mitigation.file_changes.at(0)?.status).toBe('upsert')
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

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
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

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
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

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
})

test('parseReviewRecord rejects unsafe file change paths', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: '../server.ts',
      status: 'deleted'
    }
  ]

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
})

test('parseReviewRecord rejects file change paths with surrounding whitespace', () => {
  const record = validReviewRecord()
  record.mitigation.file_changes = [
    {
      path: ' src/server.ts ',
      status: 'deleted'
    }
  ]

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
})

test('parseReviewRecord rejects unsupported public fields', () => {
  const record = validReviewRecord()
  record.analysis.status = 'error'

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
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

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
})

test('parseReviewRecord rejects malformed v1 review_record', () => {
  expect(() =>
    parseReviewRecord({
      analysis: {
        verdict: 'confirmed-vulnerability',
        overview: 'Unsafe path handling.',
        narratives: []
      }
    })
  ).toThrow(/review_record does not match API v1/)
})

test('parseReviewRecord rejects unknown public enum values', () => {
  const record = validReviewRecord()
  record.verification.coverage = 'future-coverage'

  expect(() => parseReviewRecord(record)).toThrow(/review_record does not match API v1/)
})
