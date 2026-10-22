import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import type { Pool, PoolClient } from 'pg'

import { applySchemaVersions } from '../src/database/schema-version-runner.js'

function poolWithAppliedVersions(
  rows: Array<{ version: number; name: string; checksum: string }>,
  statements: Array<{ sql: string; parameters?: unknown[] }> = [],
): Pool {
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (sql.includes('select version,name,checksum')) {
        return Promise.resolve({ rows, rowCount: rows.length })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    release: () => undefined,
  } as unknown as PoolClient
  return {
    connect: () => Promise.resolve(client),
  } as unknown as Pool
}

void test('applies the initial catalog schema and records its checksum', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []

  await applySchemaVersions(poolWithAppliedVersions([], statements))

  assert.ok(
    statements.some(({ sql }) => sql.includes('create table revisions')),
  )
  const ledgerInsert = statements.find(({ sql }) =>
    sql.includes('insert into schema_versions'),
  )
  assert.equal(ledgerInsert?.parameters?.[0], 1)
  assert.equal(ledgerInsert?.parameters?.[1], 'initial_catalog')
  assert.match(String(ledgerInsert?.parameters?.[2]), /^[a-f0-9]{64}$/)
})

void test('rejects a database schema newer than this catalog understands', async () => {
  await assert.rejects(
    applySchemaVersions(
      poolWithAppliedVersions([
        { version: 2, name: 'future', checksum: 'future' },
      ]),
    ),
    /schema version 2 is newer/,
  )
})

void test('rejects changes to an applied schema version', async () => {
  const sql = await readFile(
    new URL(
      '../src/database/schema-versions/001_initial_catalog.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const checksum = crypto.createHash('sha256').update(sql).digest('hex')

  await assert.rejects(
    applySchemaVersions(
      poolWithAppliedVersions([
        { version: 1, name: 'initial_catalog', checksum: `${checksum}changed` },
      ]),
    ),
    /no longer matches its checked-in SQL file/,
  )
})
