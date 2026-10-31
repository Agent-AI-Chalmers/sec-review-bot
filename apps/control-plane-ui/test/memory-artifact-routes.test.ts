import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { buildMemoryTreeArtifact } from '../server/memory/memory-tree-artifact.js'
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

/** Distinct stored objects make incorrect reference selection observable through HTTP. */
async function memoryArtifactFixture(t: TestContext): Promise<{
  get(path: string): Promise<Response>
  catalogReply: { status: number; body: string }
  catalogReads: string[]
  objectReads: string[]
  tree: Buffer
  maintenance: Buffer
  extraction: Buffer
}> {
  const tree = await buildMemoryTreeArtifact(
    new Map([['MEMORY.md', '# Memory\n']])
  )
  const trajectory = (content: string): Buffer =>
    zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          event: 'message',
          message: { type: 'ai', content, tool_calls: [] }
        }) + '\n'
      )
    )
  const maintenance = trajectory('Maintenance trajectory')
  const extraction = trajectory('Extraction trajectory')
  const maintenanceKey =
    'memory/trajectories/maintenance/trajectory.v1.jsonl.zst'
  const extractionKey = 'memory/trajectories/extraction/trajectory.v1.jsonl.zst'
  const trajectoryReference = (key: string, bytes: Buffer): object => ({
    uri: `s3://sec-review/${key}`,
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    size_bytes: bytes.length,
    media_type: 'application/zstd'
  })
  const catalogReply = {
    status: 200,
    body: JSON.stringify({
      memory_tree_reference: {
        uri: `s3://sec-review/${tree.objectKey}`,
        digest: tree.digest,
        size_bytes: tree.sizeBytes,
        media_type: tree.mediaType
      },
      trajectory_reference: trajectoryReference(extractionKey, extraction),
      source: {
        kind: 'maintenance',
        trajectory_reference: trajectoryReference(maintenanceKey, maintenance)
      }
    })
  }
  const catalogReads: string[] = []
  const objectReads: string[] = []
  const objects = new Map([
    [tree.objectKey, tree.bytes],
    [maintenanceKey, maintenance],
    [extractionKey, extraction]
  ])
  const catalog = createServer((request, response) => {
    catalogReads.push(request.url ?? '')
    response.writeHead(catalogReply.status, {
      'content-type': 'application/json'
    })
    response.end(catalogReply.body)
  })
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => catalog.close(() => resolve())))
  const catalogAddress = catalog.address()
  assert(catalogAddress && typeof catalogAddress === 'object')
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    memoryCatalogUrl: `http://127.0.0.1:${catalogAddress.port}`,
    memoryCatalogOperatorToken: 'catalog-secret',
    artifactStore: {
      getObject: async (key) => {
        objectReads.push(key)
        const bytes = objects.get(key)
        assert(bytes, `unexpected object ${key}`)
        return { body: Readable.from([bytes]), contentLength: bytes.length }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => ui.close(() => resolve())))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const cookie = await loginCookie(base)
  return {
    get: (path) => fetch(`${base}/api/memory${path}`, { headers: { cookie } }),
    catalogReply,
    catalogReads,
    objectReads,
    tree: tree.bytes,
    maintenance,
    extraction
  }
}

test('memory artifact routes select the declared source for downloads and content previews', async (t) => {
  const fixture = await memoryArtifactFixture(t)
  for (const [path, bytes, filename] of [
    ['/revisions/2/artifact', fixture.tree, 'memory-tree.v1.tar.zst'],
    [
      '/revisions/2/trajectory',
      fixture.maintenance,
      'memory-trajectory.v1.jsonl.zst'
    ],
    [
      '/extractions/extract-1/trajectory',
      fixture.extraction,
      'memory-trajectory.v1.jsonl.zst'
    ]
  ] as const) {
    const response = await fixture.get(path)
    assert.equal(response.status, 200, path)
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="${filename}"`
    )
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  const tree = await fixture.get('/revisions/2/content')
  assert.equal(tree.status, 200)
  assert.deepEqual(await tree.json(), { files: { 'MEMORY.md': '# Memory\n' } })
  for (const [path, content] of [
    ['/revisions/2/trajectory/content', 'Maintenance trajectory'],
    ['/extractions/extract-1/trajectory/content', 'Extraction trajectory']
  ]) {
    const response = await fixture.get(path)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      events: [
        {
          seq: 1,
          event: 'message',
          message: { type: 'ai', content, tool_calls: [] }
        }
      ]
    })
  }
  assert.equal(fixture.objectReads.length, 6)
  assert.deepEqual(fixture.catalogReads, [
    '/v1/memory-tree/revisions/2',
    '/v1/memory-tree/revisions/2',
    '/v1/extractions/extract-1',
    '/v1/memory-tree/revisions/2',
    '/v1/memory-tree/revisions/2',
    '/v1/extractions/extract-1'
  ])
})

test('invalid artifact identities and extraction tree requests never reach Catalog or storage', async (t) => {
  const fixture = await memoryArtifactFixture(t)
  for (const path of [
    '/extractions/extract-1/artifact',
    '/extractions/extract-1/content',
    '/revisions/0/artifact',
    '/revisions/01/content',
    '/revisions/abc/trajectory',
    '/extractions/invalid%2Fid/trajectory'
  ]) {
    const response = await fixture.get(path)
    assert.equal(response.status, 404, path)
    assert.deepEqual(await response.json(), {
      error: 'memory_artifact_not_found'
    })
  }
  assert.deepEqual(fixture.catalogReads, [])
  assert.deepEqual(fixture.objectReads, [])
})

test('malformed Catalog records fail as upstream errors before reading object storage', async (t) => {
  const fixture = await memoryArtifactFixture(t)
  for (const body of ['null', '[]', '"record"', '42', '{']) {
    fixture.catalogReply.body = body
    const response = await fixture.get('/revisions/2/artifact')
    assert.equal(response.status, 502, body)
    assert.deepEqual(await response.json(), {
      error: 'memory_artifact_download_failed'
    })
  }
  assert.deepEqual(fixture.objectReads, [])
})

test('revision trajectories require a maintenance source while unavailable references remain 409', async (t) => {
  const fixture = await memoryArtifactFixture(t)
  const record: unknown = JSON.parse(fixture.catalogReply.body)
  assert(
    record && typeof record === 'object' && 'trajectory_reference' in record
  )
  for (const source of [
    undefined,
    null,
    [],
    'maintenance',
    { kind: 'operator', trajectory_reference: record.trajectory_reference }
  ]) {
    fixture.catalogReply.body = JSON.stringify({
      source,
      trajectory_reference: record.trajectory_reference
    })
    const response = await fixture.get('/revisions/2/trajectory')
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'memory_artifact_unavailable'
    })
  }
  assert.deepEqual(fixture.objectReads, [])
})
