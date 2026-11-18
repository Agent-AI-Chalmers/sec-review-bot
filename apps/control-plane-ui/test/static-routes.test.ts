import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

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
  expect.assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const root = await fetch(`${base}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await root.text()).toBe('<html>app</html>')

    const script = await fetch(`${base}/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript')
    expect(await script.text()).toBe('console.log("app")')

    const fallback = await fetch(`${base}/runs/unknown`)
    expect(fallback.status).toBe(200)
    expect(fallback.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await fallback.text()).toBe('<html>app</html>')
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      rm(assets, { recursive: true, force: true })
    ])
  }
})
