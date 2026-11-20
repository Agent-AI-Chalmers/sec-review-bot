// A retry of the same operation must return the original result, even when it overlaps the first
// attempt. A client that times out and retries while its first request is still committing would
// otherwise see 409 for an operation that actually succeeded.
//
// The overlap is forced, not hoped for: a second session holds the singleton row the operation
// locks, both attempts start and block behind it, and only then is the lock released. That is the
// window in which both attempts have already looked for a replay and found none.
import crypto from 'node:crypto'
import { expect, test } from 'vitest'

import { Pool, type PoolClient } from 'pg'

import { PostgresMemoryCatalogStore } from '../../src/catalog-store.js'
import type { Actor } from '../../src/contract-types.generated.js'

const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl === undefined) {
  throw new Error('TEST_DATABASE_URL is required for integration tests.')
}

const actor: Actor = { kind: 'user', id: 'reviewer@example.com' }

async function withStore(
  run: (store: PostgresMemoryCatalogStore, pool: Pool) => Promise<void>
): Promise<void> {
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
    await run(store, pool)
  } finally {
    await pool.end()
    await administrator.query(`drop schema if exists ${schema} cascade`)
    await administrator.end()
  }
}

/** Run `attempts` while a second session holds `lockSql`, and release it only once every attempt
 * is blocked behind that session.
 *
 * Waiters are counted along the `pg_blocking_pids` chain that starts at the holder's own backend,
 * so sessions of other tests sharing the server cannot make the overlap look established early.
 *
 * Releasing the lock and settling every started attempt happen in `finally`, whether the wait
 * succeeded or not. An attempt left blocked, or a holder connection left checked out, would hang
 * `pool.end()`. */
async function overlapBehindLock<T>(
  pool: Pool,
  lockSql: string,
  attempts: Array<() => Promise<T>>
): Promise<Array<PromiseSettledResult<T>>> {
  const holder: PoolClient = await pool.connect()
  const started: Array<Promise<T>> = []
  const settled: Array<PromiseSettledResult<T>> = []
  try {
    await holder.query('begin')
    await holder.query(lockSql)
    const pid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid
    expect.assert(pid !== undefined)
    started.push(...attempts.map((attempt) => attempt()))
    await waitUntilBlocked(pid, attempts.length)
  } finally {
    // Release before settling: the attempts are blocked behind this lock and cannot finish
    // while it is held. A failed rollback must not skip the release or leave attempts running.
    await holder.query('rollback').catch(() => undefined)
    holder.release()
    settled.push(...(await Promise.allSettled(started)))
  }
  return settled
}

/** Wait until `count` sessions are blocked by the backend `pid`. Observes from outside the pool,
 * since a blocked attempt may hold every remaining pool connection. */
async function waitUntilBlocked(pid: number, count: number): Promise<void> {
  const observer = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    const deadline = Date.now() + 5_000
    for (;;) {
      // Row locks queue: the first attempt waits on the holder and the next waits on the first.
      // Count every session in that chain, starting from the holder's backend.
      const blocked = await observer.query<{ blocked: string }>(
        `with recursive waiter(pid) as (
           select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
           union
           select activity.pid from pg_stat_activity activity
           join waiter on waiter.pid = any(pg_blocking_pids(activity.pid))
         )
         select count(*) as blocked from waiter`,
        [pid]
      )
      if (Number(blocked.rows[0]?.blocked) >= count) {
        return
      }
      if (Date.now() > deadline) {
        throw new Error(`fewer than ${count} attempts blocked behind the lock`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    await observer.end()
  }
}

test('an overlapping retry of an automation change replays instead of conflicting', async () => {
  await withStore(async (store, pool) => {
    const pause = { operation_id: 'pause-1', expected_version: 0, actor }
    const results = await overlapBehindLock(
      pool,
      'select 1 from memory_tree_automation where singleton=true for update',
      [
        () => store.changeMemoryTreeAutomation('paused', pause),
        () => store.changeMemoryTreeAutomation('paused', pause)
      ]
    )
    expect(
      results.map((result) => result.status),
      'neither attempt may fail'
    ).toStrictEqual(['fulfilled', 'fulfilled'])
    const created = results.map(
      (result) => (result as PromiseFulfilledResult<{ created: boolean }>).value.created
    )
    expect(created.toSorted()).toStrictEqual([false, true])
  })
})

test('an overlapping retry of a restore replays instead of conflicting', async () => {
  await withStore(async (store, pool) => {
    // Version 1 must exist to be restored to; it is inserted directly so the test depends only on
    // the restore path.
    await pool.query(
      `insert into memory_tree_versions (
         version, predecessor_version, memory_tree_reference, source_kind, operation_id, actor
       ) values (1, null, $1, 'manual', 'seed', $2)`,
      [
        {
          uri: 's3://sec-review/memory/trees/seed.tar.zst',
          digest: `sha256:${'a'.repeat(64)}`,
          media_type: 'application/zstd',
          size_bytes: 42
        },
        actor
      ]
    )
    await pool.query('update memory_tree_state set active_version=1 where singleton=true')
    const restore = {
      operation_id: 'restore-1',
      expected_active_version: 1,
      restored_version: 1,
      actor
    }
    const results = await overlapBehindLock(
      pool,
      'select 1 from memory_tree_state where singleton=true for update',
      [() => store.restoreMemoryTree(restore), () => store.restoreMemoryTree(restore)]
    )
    expect(
      results.map((result) => result.status),
      'neither attempt may fail'
    ).toStrictEqual(['fulfilled', 'fulfilled'])
    const created = results.map(
      (result) => (result as PromiseFulfilledResult<{ created: boolean }>).value.created
    )
    expect(created.toSorted()).toStrictEqual([false, true])
  })
})
