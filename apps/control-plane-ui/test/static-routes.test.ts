import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlPlaneUiBffServer } from '../server/create-bff.js'

test('BFF serves built assets and falls back to index.html for unknown paths', async () => {
  const assets = await mkdtemp(path.join(tmpdir(), 'control-plane-ui-assets-'))
  await writeFile(path.join(assets, 'index.html'), '<html>app</html>')
  await writeFile(path.join(assets, 'app.js'), 'console.log("app")')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    assets
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const root = await fetch(`${base}/`)
    assert.strictEqual(root.status, 200)
    assert.strictEqual(
      root.headers.get('content-type'),
      'text/html; charset=utf-8'
    )
    assert.strictEqual(await root.text(), '<html>app</html>')

    const script = await fetch(`${base}/app.js`)
    assert.strictEqual(script.status, 200)
    assert.strictEqual(script.headers.get('content-type'), 'text/javascript')
    assert.strictEqual(await script.text(), 'console.log("app")')

    const fallback = await fetch(`${base}/runs/unknown`)
    assert.strictEqual(fallback.status, 200)
    assert.strictEqual(
      fallback.headers.get('content-type'),
      'text/html; charset=utf-8'
    )
    assert.strictEqual(await fallback.text(), '<html>app</html>')
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      rm(assets, { recursive: true, force: true })
    ])
  }
})
