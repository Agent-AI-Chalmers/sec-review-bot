import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

import type { Pool, PoolClient } from 'pg'

import { applySchemaVersions } from '../src/database/schema-version-runner.js'

function poolWithAppliedVersions(
  rows: Array<{ version: number; name: string; checksum: string }>,
  statements: Array<{ sql: string; parameters?: unknown[] }> = []
): Pool {
  const client = {
    query: (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, ...(parameters ? { parameters } : {}) })
      if (sql.includes('select version,name,checksum')) {
        return Promise.resolve({ rows, rowCount: rows.length })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
    release: () => undefined
  } as unknown as PoolClient
  return {
    connect: () => Promise.resolve(client)
  } as unknown as Pool
}

test('applies the complete catalog schema as version 1', async () => {
  const statements: Array<{ sql: string; parameters?: unknown[] }> = []

  await applySchemaVersions(poolWithAppliedVersions([], statements))

  expect.assert(
    statements.some(({ sql }) =>
      sql.includes('create table memory_tree_versions')
    )
  )
  expect.assert(
    statements.some(({ sql }) =>
      sql.includes('create table memory_tree_automation')
    )
  )
  expect.assert(statements.some(({ sql }) => sql.includes('source_kind text')))
  expect.assert(
    statements.some(({ sql }) =>
      sql.includes('create table memory_tree_automation_operations')
    )
  )
  const ledgerInserts = statements.filter(({ sql }) =>
    sql.includes('insert into schema_versions')
  )
  expect(
    ledgerInserts.map(({ parameters }) => parameters?.slice(0, 2))
  ).toStrictEqual([[1, 'initial_catalog']])
  for (const insert of ledgerInserts)
    expect(String(insert.parameters?.[2])).toMatch(/^[a-f0-9]{64}$/)
})

test('rejects a database schema newer than this catalog understands', async () => {
  await expect(
    applySchemaVersions(
      poolWithAppliedVersions([
        { version: 2, name: 'future', checksum: 'future' }
      ])
    )
  ).rejects.toThrow(/schema version 2 is newer/)
})

test('rejects changes to an applied schema version', async () => {
  const sql = await readFile(
    new URL(
      '../src/database/schema-versions/001_initial_catalog.sql',
      import.meta.url
    ),
    'utf8'
  )
  const checksum = crypto.createHash('sha256').update(sql).digest('hex')

  await expect(
    applySchemaVersions(
      poolWithAppliedVersions([
        { version: 1, name: 'initial_catalog', checksum: `${checksum}changed` }
      ])
    )
  ).rejects.toThrow(/no longer matches its checked-in SQL file/)
})
