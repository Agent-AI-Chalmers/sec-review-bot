// Run an operation in one database transaction, releasing the client either way.
//
// The four stores each used to carry a byte-identical copy of this function. That is one
// implementation's worth of policy - how a transaction begins, how a failure is rolled back, and
// that the client always returns to the pool - spread across four files, so any change to it had
// to be made four times and silently diverged if it was not. It lives in its own module for the
// same reason `publication-abandon.ts` does: every store may import it, and it imports none of
// them, so the stores stay independent of each other.
import type { Pool, PoolClient } from 'pg'

/** Run `operation` on one pooled client inside BEGIN/COMMIT.
 *
 * A throw from `operation` rolls the transaction back and rethrows, so a caller never observes a
 * partially applied write. The client is released in `finally`; a failed ROLLBACK still releases
 * it, because leaving a client checked out would leak the pool.
 */
export async function transaction<T>(
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
