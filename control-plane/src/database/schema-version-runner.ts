import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'

const SCHEMA_LOCK_ID = 734_620_114
const SCHEMA_VERSIONS = [
  {
    version: 1,
    name: 'initial_coordination_schema',
    file: 'schema-versions/001_initial_coordination_schema.sql'
  }
] as const

interface AppliedSchemaVersion {
  version: number
  name: string
  checksum: string
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function loadSchemaVersion(file: string): Promise<{ sql: string; checksum: string }> {
  const sql = await readFile(new URL(file, import.meta.url), 'utf8')
  return {
    sql,
    checksum: crypto.createHash('sha256').update(sql).digest('hex')
  }
}

export async function applySchemaVersions(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    // All replicas use the same transaction-scoped lock. Only one can inspect
    // and advance the schema ledger at a time; PostgreSQL releases it on commit.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_versions (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`)

    const applied = await client.query<AppliedSchemaVersion>(
      'SELECT version,name,checksum FROM schema_versions ORDER BY version'
    )
    const appliedByVersion = new Map(applied.rows.map((item) => [item.version, item]))
    const knownVersions = new Set<number>(SCHEMA_VERSIONS.map((item) => item.version))
    const unknown = applied.rows.find((item) => !knownVersions.has(item.version))
    if (unknown !== undefined) {
      // This normally means an older application image is pointed at a newer
      // database. Starting it could make assumptions the newer schema broke.
      throw new Error(
        `Database schema version ${unknown.version} is newer than this application understands.`
      )
    }

    for (const schemaVersion of SCHEMA_VERSIONS) {
      const source = await loadSchemaVersion(schemaVersion.file)
      const existing = appliedByVersion.get(schemaVersion.version)
      if (existing !== undefined) {
        if (existing.name !== schemaVersion.name || existing.checksum !== source.checksum) {
          throw new Error(
            `Applied schema version ${schemaVersion.version} no longer matches its checked-in SQL file.`
          )
        }
        continue
      }

      await client.query(source.sql)
      await client.query('INSERT INTO schema_versions (version,name,checksum) VALUES ($1,$2,$3)', [
        schemaVersion.version,
        schemaVersion.name,
        source.checksum
      ])
    }
  })
}
