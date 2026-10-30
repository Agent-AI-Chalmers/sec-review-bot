import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import tar from 'tar-stream'

import { createControlPlaneUiServer } from '../server/index.js'

async function diagnosticBundle(runId: string): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collecting = (async (): Promise<void> => {
    for await (const chunk of pack as unknown as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk))
  })()
  const entries = [
    [
      'manifest.json',
      JSON.stringify({
        version: 1,
        run_id: runId,
        result: 'result.json',
        review_units: [
          {
            id: 'unit-1',
            trajectories: ['artifact-tree/unit-1/review.jsonl']
          }
        ]
      })
    ],
    ['result.json', '{"status":"completed"}'],
    ['artifact-tree/unit-1/review.jsonl', '{"event":"message"}\n']
  ] as const
  for (const [name, value] of entries) {
    const body = Buffer.from(value)
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        { name, type: 'file', size: body.length, mtime: new Date(0) },
        body,
        (error) => (error ? reject(error) : resolve())
      )
    })
  }
  pack.finalize()
  await collecting
  return zstdCompressSync(Buffer.concat(chunks))
}

async function loginCookie(base: string): Promise<string> {
  const login = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"token":"login-secret"}'
  })
  const cookie = login.headers.get('set-cookie')
  assert(cookie !== null)
  return cookie
}

test('BFF marks session cookies secure for HTTPS proxy deployments', async () => {
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    secureCookies: true
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const login = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })

    assert.match(login.headers.get('set-cookie') ?? '', /; Secure(?:;|$)/)
  } finally {
    await new Promise<void>((resolve, reject) =>
      ui.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('BFF bounds browser sessions by evicting the oldest login', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"runs":[]}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    maximumSessions: 2
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const first = await loginCookie(base)
    const second = await loginCookie(base)
    const third = await loginCookie(base)

    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { headers: { cookie: first } })).status,
      401
    )
    for (const cookie of [second, third])
      assert.strictEqual(
        (await fetch(`${base}/api/runs`, { headers: { cookie } })).status,
        200
      )
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF authenticates sessions and proxies only read queries', async () => {
  let authorization = ''
  let upstreamPath = ''
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization ?? ''
    upstreamPath = request.url ?? ''
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"runs":[]}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    assert.strictEqual((await fetch(`${base}/api/runs`)).status, 401)
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })
    assert.strictEqual(login.status, 204)
    const cookie = login.headers.get('set-cookie')
    assert(cookie?.includes('HttpOnly'))
    assert(cookie !== null)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(query.status, 200)
    assert.strictEqual(authorization, 'Bearer read-secret')
    assert.strictEqual(upstreamPath, '/v1/runs')
    // The BFF forwards only the parameters Review Runs declares: UI state (`range`) and
    // anything else the browser adds (UTM, typos) are dropped rather than passed upstream.
    await fetch(`${base}/api/runs?range=1h&utm_source=twitter&limit=10`, {
      headers: { cookie }
    })
    assert.strictEqual(upstreamPath, '/v1/runs?limit=10')
    await fetch(
      `${base}/api/runs?workflow=issue-review&source_platform=github&range=7d&cursor=abc`,
      { headers: { cookie } }
    )
    assert.strictEqual(
      upstreamPath,
      '/v1/runs?cursor=abc&source_platform=github&workflow=issue-review'
    )
    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { method: 'POST', headers: { cookie } }))
        .status,
      404
    )
    assert.strictEqual(
      (await fetch(`${base}/api/store`, { headers: { cookie } })).status,
      404
    )
    // The run-id segment must be the contract's UUID shape. A catch-all would still be safe
    // today (Review Runs answers 400), but it would forward any future path shape upstream,
    // so the allow-list rejects a non-UUID id here instead of relaying it.
    const runUuid = '0123abcd-4567-89ef-0123-456789abcdef'
    await fetch(`${base}/api/runs/${runUuid}/events`, { headers: { cookie } })
    assert.strictEqual(upstreamPath, `/v1/runs/${runUuid}/events`)
    upstreamPath = ''
    // The allow-list matches the contract's run-id shape after percent-decoding. It is
    // deliberately shape-only, exactly like the contract's own `runId` pattern: rejecting a
    // version/variant nibble here would make the BFF stricter than the contract it proxies.
    // What it must never do is let a crafted segment reach a different upstream path, which is
    // what the traversal and encoding cases below pin.
    for (const rejected of [
      '/api/runs/not-a-uuid',
      '/api/runs/not-a-uuid/events',
      '/api/runs/%2e%2e/publication-steps',
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef/unknown-suffix',
      // Traversal hidden in the id segment: rejected before normalisation can reshape the path.
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef/../..%2Fparked',
      '/api/runs/..%2F..%2Fparked',
      // A valid id with an encoded separator glued to it is not a sub-resource.
      '/api/runs/0123abcd-4567-89ef-0123-456789abcdef%2Fevents'
    ]) {
      assert.strictEqual(
        (await fetch(`${base}${rejected}`, { headers: { cookie } })).status,
        404,
        `${rejected} must not be proxied upstream`
      )
    }
    assert.strictEqual(
      upstreamPath,
      '',
      'a rejected path must never reach the upstream Review Runs'
    )
    // The blocked-preparation queue is a fixed sub-resource of the run collection, not a run id,
    // so it must pass the allow-list before the UUID check rejects it.
    await fetch(`${base}/api/runs/parked`, {
      headers: { cookie }
    })
    assert.strictEqual(upstreamPath, '/v1/runs/parked')

    // The one write the console may proxy. The admin credential is supplied by the operator for
    // this request and forwarded as-is; the BFF holds no copy of its own.
    const abandonUrl = `${base}/api/admin/runs/${runUuid}/abandon`
    // Same origin but no operator credential: the request is well formed, it just cannot act.
    const noToken = await fetch(abandonUrl, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: '{"reason":"r"}'
    })
    assert.strictEqual(noToken.status, 401)
    const crossSite = await fetch(abandonUrl, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'x-review-runs-admin-token': 'admin-value'
      },
      body: '{"reason":"r"}'
    })
    assert.strictEqual(
      crossSite.status,
      403,
      'a cross-site POST must not carry the session into an abandonment'
    )
    authorization = ''
    const abandon = await fetch(abandonUrl, {
      method: 'POST',
      headers: {
        cookie,
        origin: base,
        'content-type': 'application/json',
        'x-review-runs-admin-token': 'admin-value'
      },
      body: '{"reason":"r"}'
    })
    assert.strictEqual(abandon.status, 200)
    assert.strictEqual(upstreamPath, `/v1/admin/runs/${runUuid}/abandon`)
    assert.strictEqual(
      authorization,
      'Bearer admin-value',
      'the operator credential, not the read token, must authorise the abandonment'
    )
    const oversizedLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'x'.repeat(1024 * 1024) })
    })
    assert.strictEqual(oversizedLogin.status, 413)
    const unicodeLogin = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: '\u00e9'.repeat('login-secret'.length) })
    })
    assert.strictEqual(unicodeLogin.status, 401)
    assert.strictEqual((await fetch(`${base}/healthz`)).status, 200)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects an upstream JSON body whose declared size exceeds its budget', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '5'
    })
    response.end('12345')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    upstreamJsonMaxBytes: 4
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'upstream_response_too_large'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF stops buffering a chunked upstream JSON body at its budget', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('1234')
    response.end('5')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    upstreamJsonMaxBytes: 4
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(response.status, 502)
    assert.deepStrictEqual(await response.json(), {
      error: 'upstream_response_too_large'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('memory writes require configured catalog access', async () => {
  const reviewRuns = createServer((_request, response) => response.end('{}'))
  await new Promise<void>((resolve) =>
    reviewRuns.listen(0, '127.0.0.1', resolve)
  )
  const reviewAddress = reviewRuns.address()
  assert(reviewAddress && typeof reviewAddress === 'object')
  const ui = createControlPlaneUiServer({
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
  const ui = createControlPlaneUiServer({
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
  const ui = createControlPlaneUiServer({
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
    assert.strictEqual(requests[1]!.path, '/v1/memory-tree/restore')
    assert.deepStrictEqual(requests[1]!.body, {
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
  const ui = createControlPlaneUiServer({
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
  const ui = createControlPlaneUiServer({
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
  const ui = createControlPlaneUiServer({
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
    assert.strictEqual(response.status, 409)
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
  const ui = createControlPlaneUiServer({
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

/**
 * Sign-out has to expire the session cookie server-side: it is HttpOnly, so the console
 * cannot clear it from script. The regression this prevents is a console that appears to
 * sign out while the cookie keeps working, which silently leaves the reader authenticated.
 */
test('BFF sign-out expires the session cookie it issued', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"runs":[]}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie !== null)
    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { headers: { cookie } })).status,
      200
    )

    // A browser attaches `Origin` to a non-GET request, even same-origin; sign-out is
    // refused without it (see the cross-site test below).
    const signOut = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { origin: base }
    })
    assert.strictEqual(signOut.status, 204)
    const cleared = signOut.headers.get('set-cookie')
    // Without Max-Age=0 the browser would keep the original cookie and stay signed in.
    assert(cleared?.includes('Max-Age=0'))
    assert(cleared?.includes('HttpOnly'))

    // The cleared value must not authenticate, even if a client replays it verbatim.
    const replayed = cleared ?? ''
    assert.strictEqual(
      (await fetch(`${base}/api/runs`, { headers: { cookie: replayed } }))
        .status,
      401
    )
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

/**
 * Another site must not be able to sign the reader out. The cookie is `SameSite=Strict`,
 * so a cross-site request will not carry it, but sign-out clears the cookie regardless —
 * a cross-site DELETE would still be obeyed without this check. The regression this
 * prevents is a request the browser would never have sent carrying a session.
 */
test('BFF refuses a cross-site sign-out', async () => {
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    // A different origin, and the shape an attacker can actually produce.
    const crossSite = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { origin: 'https://attacker.example' }
    })
    assert.strictEqual(crossSite.status, 403)
    assert.deepStrictEqual(await crossSite.json(), { error: 'cross_origin' })
    // No cookie is cleared on the rejected path: an attacker cannot even produce the
    // side effect they were after.
    assert.strictEqual(crossSite.headers.get('set-cookie'), null)

    // A request that carries neither `Origin` nor `Referer` is also refused, since an
    // attacker can omit both.
    assert.strictEqual(
      (await fetch(`${base}/api/session`, { method: 'DELETE' })).status,
      403
    )

    // `Referer` alone is enough, so a same-origin caller that could not set `Origin`
    // still signs out.
    const viaReferer = await fetch(`${base}/api/session`, {
      method: 'DELETE',
      headers: { referer: `${base}/runs` }
    })
    assert.strictEqual(viaReferer.status, 204)
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})

test('BFF returns a gateway error when Review Runs is unavailable', async () => {
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: 'http://127.0.0.1:1',
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert.strictEqual(login.status, 204)
    assert(cookie)
    const query = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(query.status, 502)
    assert.deepStrictEqual(await query.json(), {
      error: 'review_runs_unavailable'
    })
  } finally {
    await new Promise<void>((resolve) => ui.close(() => resolve()))
  }
})

test('BFF streams only the artifact referenced by an authenticated run', async () => {
  const runId = 'run-1'
  const artifactBody = 'artifact'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/tar+zstd',
              digest: `sha256:${crypto.createHash('sha256').update(artifactBody).digest('hex')}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  let requestedKey = ''
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(key): Promise<{ body: Readable; contentLength: number }> {
        requestedKey = key
        return { body: Readable.from([artifactBody]), contentLength: 8 }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    assert.strictEqual(
      (await fetch(`${base}/api/runs/${runId}/artifact`)).status,
      401
    )
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 200)
    assert.strictEqual(await download.text(), 'artifact')
    assert.strictEqual(
      requestedKey,
      `runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
    )
    assert.strictEqual(
      download.headers.get('content-type'),
      'application/octet-stream'
    )
    assert.strictEqual(
      download.headers.get('content-disposition'),
      'attachment; filename="diagnostic-tree.v1.tar.zst"'
    )
    assert.strictEqual(
      download.headers.get('cache-control'),
      'private, no-store'
    )
    assert.strictEqual(
      download.headers.get('x-content-type-options'),
      'nosniff'
    )
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF verifies and reads a diagnostic bundle for the run files viewer', async () => {
  const runId = 'run-files-1'
  const artifactBody = await diagnosticBundle(runId)
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/tar+zstd',
              digest: `sha256:${crypto.createHash('sha256').update(artifactBody).digest('hex')}`,
              size_bytes: artifactBody.length
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return {
          body: Readable.from([artifactBody]),
          contentLength: artifactBody.length
        }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const cookie = await loginCookie(base)
    const response = await fetch(`${base}/api/runs/${runId}/artifact/content`, {
      headers: { cookie }
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), {
      files: {
        'manifest.json': JSON.stringify({
          version: 1,
          run_id: runId,
          result: 'result.json',
          review_units: [
            {
              id: 'unit-1',
              trajectories: ['artifact-tree/unit-1/review.jsonl']
            }
          ]
        }),
        'result.json': '{"status":"completed"}',
        'artifact-tree/unit-1/review.jsonl': '{"event":"message"}\n'
      },
      unpreviewable_files: {}
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects artifact metadata that does not belong to the requested run', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: 'run-1',
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: 's3://sec-review/runs/run-2/artifacts/diagnostic-tree.v1.tar.zst',
              media_type: 'application/tar+zstd',
              digest: `sha256:${'a'.repeat(64)}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  let storageCalled = false
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable }> {
        storageCalled = true
        return { body: Readable.from([]) }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/run-1/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 409)
    assert.strictEqual(storageCalled, false)
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects an object whose size does not match the available artifact', async () => {
  const runId = 'run-1'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/tar+zstd',
              digest: `sha256:${'a'.repeat(64)}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return { body: Readable.from(['wrong']), contentLength: 5 }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 502)
    assert.deepStrictEqual(await download.json(), {
      error: 'artifact_identity_mismatch'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF rejects same-size artifact content that does not match the stored digest', async () => {
  const runId = 'run-1'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/tar+zstd',
              digest: `sha256:${crypto.createHash('sha256').update('expected').digest('hex')}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return { body: Readable.from(['replaced']), contentLength: 8 }
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 502)
    assert.deepStrictEqual(await download.json(), {
      error: 'artifact_identity_mismatch'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF times out a stalled artifact download', async () => {
  const runId = 'run-1'
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        run: {
          run_id: runId,
          artifact_storage: {
            status: 'available',
            artifact: {
              kind: 'diagnostic_bundle',
              uri: `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`,
              media_type: 'application/tar+zstd',
              digest: `sha256:${'a'.repeat(64)}`,
              size_bytes: 8
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    artifactDownloadIdleTimeoutMs: 20,
    artifactStore: {
      async getObject(_key, signal): Promise<{ body: Readable }> {
        return await new Promise((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        })
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/${runId}/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 504)
    assert.deepStrictEqual(await download.json(), {
      error: 'artifact_download_timeout'
    })
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF reports a Review Runs metadata timeout separately', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"run":')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    reviewRunsRequestTimeoutMs: 20,
    artifactStore: {
      async getObject(): Promise<{ body: Readable }> {
        throw new Error('must not be called')
      }
    }
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const address = ui.address()
  assert(address && typeof address === 'object')
  try {
    const base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'login-secret' })
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie)
    const download = await fetch(`${base}/api/runs/run-1/artifact`, {
      headers: { cookie }
    })
    assert.strictEqual(download.status, 504)
    assert.deepStrictEqual(await download.json(), {
      error: 'review_runs_timeout'
    })
  } finally {
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})

test('BFF does not echo an upstream content-type it would serve as script', async () => {
  // The upstream `content-type` could be `text/html` if Review Runs were compromised or
  // misconfigured. Echoing it from the console's own origin would let a browser run the body as
  // script; the BFF must answer with a fixed JSON type instead, regardless of what it is sent.
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<script>alert(1)</script>')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')
  const ui = createControlPlaneUiServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret'
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  const uiAddress = ui.address()
  assert(uiAddress && typeof uiAddress === 'object')
  const base = `http://127.0.0.1:${uiAddress.port}`
  try {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"token":"login-secret"}'
    })
    const cookie = login.headers.get('set-cookie')
    assert(cookie !== null)
    const proxied = await fetch(`${base}/api/runs`, { headers: { cookie } })
    assert.strictEqual(proxied.status, 200)
    assert.strictEqual(
      proxied.headers.get('content-type'),
      'application/json; charset=utf-8',
      'the upstream text/html must not be echoed'
    )
    assert.strictEqual(
      proxied.headers.get('x-content-type-options'),
      'nosniff',
      'nosniff is still set so the body cannot be reinterpreted'
    )
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})
