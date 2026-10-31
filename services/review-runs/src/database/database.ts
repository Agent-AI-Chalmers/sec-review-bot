// The one place that knows whether the schema is in place.
//
// Every store needs the same guarantee before it may touch the database: the migrations this
// service depends on have been applied. The facade used to hold that flag and each of its
// methods had to remember `this.ready()` first — a rule enforced by repetition, and one a new
// method could silently skip. The database owns it instead: a store asks for the pool and either
// gets one that is safe to use or a refusal.
import { Pool } from 'pg'

import {
  applySchemaVersions,
  KNOWN_SCHEMA_VERSIONS
} from './schema-version-runner.js'

export class Database {
  readonly #pool: Pool
  #initialized = false

  constructor({
    connectionString,
    pool
  }: {
    connectionString?: string
    pool?: Pool
  } = {}) {
    this.#pool = pool ?? new Pool({ connectionString })
    // `pg` emits `error` on the pool when an idle client loses its connection, and an
    // EventEmitter that emits `error` without a listener throws. A database restart, a network
    // blip, or the server reaping an idle connection would therefore kill this process -- taking
    // down every other compose service with it, because the deployment runs
    // `up --abort-on-container-failure`.
    //
    // The event carries no query to fail: the client that died was idle, so whoever needed it
    // next will get a fresh connection or a normal query error. Log it and keep running rather
    // than treating a recoverable pool event as a fatal process error.
    //
    // Only the message is logged. Printing the Error itself expands the whole pg client --
    // socket, buffer state, type parsers -- into hundreds of lines per connection, and a restart
    // severs every pooled connection at once.
    this.#pool.on('error', (error: Error) => {
      console.error('review_runs_pool_idle_client_error', error.message)
    })
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    await applySchemaVersions(this.#pool)
    this.#initialized = true
  }

  /** The pool, once this service's schema is in place.
   *
   * Every store calls this instead of holding the pool itself, so a query issued before
   * initialization fails here rather than against a half-migrated database.
   */
  pool(): Pool {
    if (!this.#initialized)
      throw new Error(
        'Review Runs database is not initialized; await initialize() before use.'
      )
    return this.#pool
  }

  /** Verify the dependency boundary required to accept coordination requests. */
  async checkLedger(): Promise<void> {
    const result = await this.pool().query<{ version: number }>(
      'SELECT version FROM schema_versions ORDER BY version'
    )
    const appliedVersions = result.rows.map(({ version }) => version)
    if (
      appliedVersions.length !== KNOWN_SCHEMA_VERSIONS.length ||
      appliedVersions.some(
        (version, index) => version !== KNOWN_SCHEMA_VERSIONS[index]
      )
    ) {
      throw new Error('Review Runs schema ledger is not current.')
    }
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}
