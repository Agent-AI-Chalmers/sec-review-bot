// Start the real BFF with its production S3 adapter and the disposable Catalog.
import { writeFile } from 'node:fs/promises'
import { createControlPlaneUiBffServer } from '../../apps/control-plane-ui/dist-server/server/create-bff.js'
import { artifactStoreFromEnvironment } from '../../apps/control-plane-ui/dist-server/server/artifacts/store.js'
const app = createControlPlaneUiBffServer({
  reviewRunsUrl: 'http://127.0.0.1:1',
  reviewRunsToken: 'unused',
  accessToken: 'seam-ui',
  memoryCatalogUrl: process.env.TEST_CATALOG_URL,
  memoryCatalogOperatorToken: 'seam-operator',
  artifactStore: artifactStoreFromEnvironment(),
})
await new Promise((resolve, reject) => {
  app.once('error', reject)
  app.listen(0, '127.0.0.1', resolve)
})
await writeFile(
  process.env.READY_FILE,
  JSON.stringify({ url: `http://127.0.0.1:${app.address().port}` }),
)
process.once('SIGTERM', () => {
  app.closeAllConnections()
  app.close()
})
