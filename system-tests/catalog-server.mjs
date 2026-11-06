// Real HTTP routes and PostgreSQL store; the Python test owns process/container cleanup.
import { writeFile } from 'node:fs/promises'
import { createApp } from '../services/memory-catalog/dist/server.js'
import { PostgresMemoryCatalogStore } from '../services/memory-catalog/dist/catalog-store.js'

const store = new PostgresMemoryCatalogStore(process.env.TEST_DATABASE_URL)
await store.initialize()
const app = await createApp({
  store,
  workerToken: 'seam-worker',
  operatorToken: 'seam-operator'
})
const url = await app.listen({ host: '127.0.0.1', port: 0 })
await writeFile(process.env.READY_FILE, JSON.stringify({ url }))
process.once('SIGTERM', async () => {
  await app.close()
  await store.close()
})
