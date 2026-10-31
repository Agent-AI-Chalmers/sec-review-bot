import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Pool, PoolClient } from 'pg'

const SCHEMA_LOCK_ID = 734_620_115
const SCHEMA_VERSIONS = [
  {
    version: 1,
    name: 'initial_catalog',
    file: 'schema-versions/001_initial_catalog.sql',
  },
] as const

interface AppliedSchemaVersion {
  version: number
  name: string
  checksum: string
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await operation(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function loadSchemaVersion(
  file: string,
): Promise<{ sql: string; checksum: string }> {
  const sql = await readFile(new URL(file, import.meta.url), 'utf8')
  return {
    sql,
    checksum: crypto.createHash('sha256').update(sql).digest('hex'),
  }
}

export async function applySchemaVersions(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID])
    await client.query(`create table if not exists schema_versions (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default clock_timestamp()
    )`)

    const applied = await client.query<AppliedSchemaVersion>(
      'select version,name,checksum from schema_versions order by version',
    )
    const knownVersions = new Set<number>(
      SCHEMA_VERSIONS.map(({ version }) => version),
    )
    const unknown = applied.rows.find(
      ({ version }) => !knownVersions.has(version),
    )
    if (unknown !== undefined) {
      throw new Error(
        `Memory Catalog schema version ${unknown.version} is newer than this application understands.`,
      )
    }
    const appliedByVersion = new Map(
      applied.rows.map((item) => [item.version, item]),
    )

    for (const schemaVersion of SCHEMA_VERSIONS) {
      const source = await loadSchemaVersion(schemaVersion.file)
      const existing = appliedByVersion.get(schemaVersion.version)
      if (existing !== undefined) {
        if (
          existing.name !== schemaVersion.name ||
          existing.checksum !== source.checksum
        ) {
          throw new Error(
            `Applied Memory Catalog schema version ${schemaVersion.version} no longer matches its checked-in SQL file.`,
          )
        }
        continue
      }

      await client.query(source.sql)
      await client.query(
        'insert into schema_versions (version,name,checksum) values ($1,$2,$3)',
        [schemaVersion.version, schemaVersion.name, source.checksum],
      )
    }
  })
}
