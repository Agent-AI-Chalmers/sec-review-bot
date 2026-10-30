import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { createControlPlaneUiBffServer } from '../server/create-bff.js'
import { loginCookie } from './server-support.js'

test('BFF verifies and strictly parses memory trajectories for the viewer', async () => {
  const trajectory = zstdCompressSync(
    Buffer.from(
      [
        JSON.stringify({
          seq: 1,
          event: 'message',
          message: { type: 'system', content: 'Maintain memory.' }
        }),
        JSON.stringify({
          seq: 2,
          event: 'message',
          message: { type: 'ai', content: 'Done.', tool_calls: [] }
        })
      ].join('\n') + '\n'
    )
  )
  const digest = `sha256:${crypto.createHash('sha256').update(trajectory).digest('hex')}`
  const catalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        revision: 2,
        source: {
          kind: 'maintenance',
          trajectory_reference: {
            uri: 's3://sec-review/memory/trajectories/memory-maintainer/example/trajectory.v1.jsonl.zst',
            digest,
            media_type: 'application/zstd',
            size_bytes: trajectory.length
          }
        }
      })
    )
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
    artifactStore: {
      getObject: async () => ({ body: Readable.from([trajectory]) })
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(
      `${base}/api/memory/revisions/2/trajectory/content`,
      { headers: { cookie } }
    )
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), {
      events: [
        {
          seq: 1,
          event: 'message',
          message: { type: 'system', content: 'Maintain memory.' }
        },
        {
          seq: 2,
          event: 'message',
          message: { type: 'ai', content: 'Done.', tool_calls: [] }
        }
      ]
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('BFF rejects a memory tree reference whose object key is not derived from its digest', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const catalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        revision: 2,
        memory_tree_reference: {
          uri: `s3://sec-review/memory/trees/${'b'.repeat(64)}/memory-tree.v1.tar.zst`,
          digest,
          media_type: 'application/tar+zstd',
          size_bytes: 1
        },
        source: {
          kind: 'operator',
          operation_id: 'edit-1'
        }
      })
    )
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  let objectReads = 0
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    artifactStore: {
      getObject: async () => {
        objectReads += 1
        return { body: Readable.from(['x']) }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/revisions/2/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(response.status, 409)
    assert.deepStrictEqual(await response.json(), {
      error: 'memory_artifact_unavailable'
    })
    assert.strictEqual(objectReads, 0)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

/**
 * The published size budget is a refusal about the object, not about the catalog: reporting
 * it as "unavailable" told the reader the wrong thing about a record that was perfectly
 * well formed, and hid which limit was crossed.
 */
test('BFF rejects oversized memory artifacts before reading object storage', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const catalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        revision: 2,
        memory_tree_reference: {
          uri: `s3://sec-review/memory/trees/${'a'.repeat(64)}/memory-tree.v1.tar.zst`,
          digest,
          media_type: 'application/tar+zstd',
          size_bytes: 64 * 1024 * 1024 + 1
        },
        source: {
          kind: 'operator',
          operation_id: 'edit-1'
        }
      })
    )
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  let objectReads = 0
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    artifactStore: {
      getObject: async () => {
        objectReads += 1
        return { body: Readable.from([]) }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/revisions/2/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(response.status, 413)
    assert.deepStrictEqual(await response.json(), {
      error: 'artifact_too_large'
    })
    assert.strictEqual(objectReads, 0)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('BFF rejects oversized memory objects before buffering their body', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const catalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        revision: 2,
        memory_tree_reference: {
          uri: `s3://sec-review/memory/trees/${'a'.repeat(64)}/memory-tree.v1.tar.zst`,
          digest,
          media_type: 'application/tar+zstd',
          size_bytes: 1
        },
        source: {
          kind: 'operator',
          operation_id: 'edit-1'
        }
      })
    )
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  let bodyRead = false
  const body = new Readable({
    read(): void {
      bodyRead = true
      this.push(null)
    }
  })
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    artifactStore: {
      getObject: async () => ({
        body,
        contentLength: 64 * 1024 * 1024 + 1
      })
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/revisions/2/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'artifact_identity_mismatch'
    })
    assert.strictEqual(bodyRead, false)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('BFF times out and closes a stalled memory artifact body', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const catalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        revision: 2,
        memory_tree_reference: {
          uri: `s3://sec-review/memory/trees/${'a'.repeat(64)}/memory-tree.v1.tar.zst`,
          digest,
          media_type: 'application/tar+zstd',
          size_bytes: 2
        },
        source: {
          kind: 'operator',
          operation_id: 'edit-1'
        }
      })
    )
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  let sentChunk = false
  let bodyClosed = false
  const body = new Readable({
    read(): void {
      if (sentChunk) return
      sentChunk = true
      this.push('x')
    }
  })
  body.once('close', () => {
    bodyClosed = true
  })
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    artifactDownloadIdleTimeoutMs: 20,
    artifactStore: {
      getObject: async () => ({ body })
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await Promise.race([
      fetch(`${base}/api/memory/revisions/2/artifact`, {
        headers: { cookie }
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('memory artifact did not time out')),
          500
        )
      )
    ])
    assert.strictEqual(response.status, 504)
    assert.deepStrictEqual(await response.json(), {
      error: 'memory_artifact_download_timeout'
    })
    assert.strictEqual(bodyClosed, true)
  } finally {
    body.destroy()
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})

test('BFF rejects same-size memory content that does not match the stored digest', async () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const catalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        revision: 2,
        memory_tree_reference: {
          uri: `s3://sec-review/memory/trees/${'a'.repeat(64)}/memory-tree.v1.tar.zst`,
          digest,
          media_type: 'application/tar+zstd',
          size_bytes: 8
        },
        source: {
          kind: 'operator',
          operation_id: 'edit-1'
        }
      })
    )
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
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return { body: Readable.from(['replaced']), contentLength: 8 }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/memory/revisions/2/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'artifact_identity_mismatch'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => catalog.close(() => resolve()))
    ])
  }
})
