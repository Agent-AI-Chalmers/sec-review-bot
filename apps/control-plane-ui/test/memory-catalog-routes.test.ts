import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createControlPlaneUiBffServer } from '../server/create-bff.js'
import { loginCookie } from './server-support.js'

test('memory writes require configured catalog access', async () => {
  const reviewRuns = createServer((_request, response) => response.end('{}'))
  await new Promise<void>((resolve) =>
    reviewRuns.listen(0, '127.0.0.1', resolve)
  )
  const reviewAddress = reviewRuns.address()
  assert(reviewAddress && typeof reviewAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${reviewAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/pause`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({
        operation_id: 'op-1',
        expected_generation: 1
      })
    })
    assert.strictEqual(response.status, 503)
    assert.deepStrictEqual(await response.json(), {
      error: 'memory_catalog_unavailable'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => reviewRuns.close(() => resolve()))
    ])
  }
})

test('BFF maps memory tree reads to the catalog memory-tree resource', async () => {
  const paths: string[] = []
  const catalog = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    for (const path of [
      '/api/memory/tree',
      '/api/memory/overview?range=90d',
      '/api/memory/revisions?limit=50',
      '/api/memory/revisions/2'
    ])
      assert.strictEqual(
        (await fetch(`${base}${path}`, { headers: { cookie } })).status,
        200
      )
    assert.deepStrictEqual(paths, [
      '/v1/memory-tree',
      '/v1/overview?range=90d',
      '/v1/memory-tree/revisions?limit=50',
      '/v1/memory-tree/revisions/2'
    ])
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('memory edit creates a revision while restore only moves the pointer', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const catalog = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      path: request.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
    })
    response.writeHead(201, { 'content-type': 'application/json' })
    response.end('{"revision":3}')
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  const reviewRuns = createServer((_request, response) => response.end('{}'))
  await new Promise<void>((resolve) =>
    reviewRuns.listen(0, '127.0.0.1', resolve)
  )
  const reviewAddress = reviewRuns.address()
  assert(reviewAddress && typeof reviewAddress === 'object')
  let uploads = 0
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${reviewAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    artifactStore: {
      getObject: () => Promise.reject(new Error('not used')),
      putMemoryArtifact: async () => {
        uploads += 1
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const headers = { cookie, origin: base, 'content-type': 'application/json' }
    assert.strictEqual(
      (
        await fetch(`${base}/api/memory/edit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            operation_id: 'edit-1',
            expected_active_revision: 2,
            files: { 'MEMORY.md': '# Memory\n' }
          })
        })
      ).status,
      201
    )
    assert.strictEqual(uploads, 1)
    assert.deepStrictEqual(
      requests.map(({ path }) => path),
      [
        '/v1/memory-tree/revisions/publications/reserve',
        '/v1/memory-tree/revisions/publications/confirm',
        '/v1/memory-tree/revisions'
      ]
    )
    assert.deepStrictEqual(requests[0]!.body, requests[1]!.body)
    assert.deepStrictEqual(requests[0]!.body, requests[2]!.body)
    const editSource = requests[0]!.body.source as Record<string, unknown>
    assert.strictEqual(editSource.actor, undefined)
    assert.strictEqual(editSource.operation_id, 'edit-1')

    assert.strictEqual(
      (
        await fetch(`${base}/api/memory/restore`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            operation_id: 'restore-1',
            expected_active_revision: 3,
            restored_revision: 1
          })
        })
      ).status,
      201
    )
    assert.strictEqual(uploads, 1, 'restore must not publish another object')
    assert.strictEqual(requests[3]!.path, '/v1/memory-tree/restore')
    assert.deepStrictEqual(requests[3]!.body, {
      operation_id: 'restore-1',
      expected_active_revision: 3,
      restored_revision: 1
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => reviewRuns.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('memory writes classify an unreachable catalog as an upstream failure', async () => {
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: 'http://127.0.0.1:1',
    memoryCatalogOperatorToken: 'catalog-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/pause`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ operation_id: 'op-1', expected_generation: 1 })
    })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'memory_catalog_unavailable'
    })
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})

test('memory writes classify a catalog timeout separately', async () => {
  const catalog = createServer(() => undefined)
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    memoryCatalogRequestTimeoutMs: 20
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/pause`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ operation_id: 'op-1', expected_generation: 1 })
    })
    assert.strictEqual(response.status, 504)
    assert.deepStrictEqual(await response.json(), {
      error: 'memory_catalog_timeout'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('memory reads use their own timeout instead of the Review Runs timeout', async () => {
  const catalog = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    }, 100)
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    reviewRunsRequestTimeoutMs: 20,
    memoryCatalogRequestTimeoutMs: 500
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/tree`, {
      headers: { cookie }
    })
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), {})
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})
