import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { type TestContext } from 'node:test'

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

/** Real authenticated BFF requests, with only Catalog and object storage replaced. */
async function memoryWriteFixture(
  t: TestContext,
  {
    upload = 'ok',
    catalogStatus = 201,
    catalogFailurePath
  }: {
    upload?: 'ok' | 'missing' | 'fails'
    catalogStatus?: number
    catalogFailurePath?: string
  } = {}
): Promise<{
  post(action: string, body: string): Promise<Response>
  writes: Array<{ path: string; body: unknown }>
  uploads: () => number
}> {
  const writes: Array<{ path: string; body: unknown }> = []
  let uploads = 0
  const catalog = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    writes.push({
      path: request.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    })
    const status =
      catalogFailurePath === undefined || request.url === catalogFailurePath
        ? catalogStatus
        : 201
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        status === 409 ? { error: 'revision_conflict' } : { created: true }
      )
    )
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
    ...(upload === 'missing'
      ? {}
      : {
          artifactStore: {
            getObject: async (): Promise<never> =>
              assert.fail('writes must not read stored objects'),
            putMemoryArtifact: async (): Promise<void> => {
              assert.equal(
                writes.at(-1)?.path,
                '/v1/memory-tree/revisions/publications/reserve'
              )
              uploads += 1
              if (upload === 'fails') throw new Error('storage unavailable')
            }
          }
        })
  })
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => ui.close(() => resolve())))
  const address = ui.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const cookie = await loginCookie(base)
  return {
    post: (action, body) =>
      fetch(`${base}/api/memory/${action}`, {
        method: 'POST',
        body,
        headers: { cookie, origin: base, 'content-type': 'application/json' }
      }),
    writes,
    uploads: () => uploads
  }
}

const validMemoryWrites = {
  pause: { operation_id: 'pause-1', expected_generation: 0 },
  resume: { operation_id: 'resume-1', expected_generation: 1 },
  restore: {
    operation_id: 'restore-1',
    expected_active_revision: 2,
    restored_revision: 1
  },
  edit: {
    operation_id: 'edit-1',
    expected_active_revision: 0,
    files: { 'MEMORY.md': '# Memory\n' }
  }
}

test('memory writes reject malformed JSON and non-object JSON without side effects', async (t) => {
  const fixture = await memoryWriteFixture(t)
  for (const action of Object.keys(validMemoryWrites)) {
    for (const body of [
      '',
      '{',
      'null',
      '[]',
      '[{}]',
      '"text"',
      '42',
      'true',
      'false'
    ]) {
      const response = await fixture.post(action, body)
      assert.equal(response.status, 400, `${action}: ${body}`)
      assert.deepEqual(await response.json(), { error: 'invalid_request' })
    }
  }
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.uploads(), 0)
})

test('memory writes require valid operation IDs before any Catalog or storage mutation', async (t) => {
  const fixture = await memoryWriteFixture(t)
  for (const [action, valid] of Object.entries(validMemoryWrites)) {
    for (const operation_id of [
      undefined,
      null,
      1,
      true,
      [],
      {},
      '',
      'has space',
      'has/slash'
    ]) {
      const response = await fixture.post(
        action,
        JSON.stringify({ ...valid, operation_id })
      )
      assert.equal(
        response.status,
        400,
        `${action}: ${JSON.stringify(operation_id)}`
      )
      assert.deepEqual(await response.json(), { error: 'invalid_request' })
    }
  }
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.uploads(), 0)
})

test('memory writes reject missing, coerced, fractional, negative, and unsafe counters', async (t) => {
  const fixture = await memoryWriteFixture(t)
  for (const [action, field] of [
    ['pause', 'expected_generation'],
    ['resume', 'expected_generation'],
    ['edit', 'expected_active_revision'],
    ['restore', 'expected_active_revision'],
    ['restore', 'restored_revision']
  ] as const) {
    const invalid = [
      undefined,
      null,
      '1',
      true,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1
    ]
    if (action === 'restore') invalid.push(0)
    for (const value of invalid) {
      const response = await fixture.post(
        action,
        JSON.stringify({ ...validMemoryWrites[action], [field]: value })
      )
      assert.equal(
        response.status,
        400,
        `${action}.${field}: ${JSON.stringify(value)}`
      )
      assert.deepEqual(await response.json(), { error: 'invalid_request' })
    }
  }
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.uploads(), 0)
})

test('memory edits validate files before reserving or uploading artifacts', async (t) => {
  const fixture = await memoryWriteFixture(t)
  for (const files of [
    undefined,
    null,
    [],
    'content',
    1,
    { 'MEMORY.md': null },
    { 'MEMORY.md': 1 }
  ]) {
    const response = await fixture.post(
      'edit',
      JSON.stringify({ ...validMemoryWrites.edit, files })
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_memory_files' })
  }
  const badPath = await fixture.post(
    'edit',
    JSON.stringify({
      ...validMemoryWrites.edit,
      files: { 'MEMORY.md': '# Memory\n', '../MEMORY.md': '# Bad path\n' }
    })
  )
  assert.equal(badPath.status, 400)
  assert.deepEqual(await badPath.json(), {
    error: 'Invalid memory tree content path: ../MEMORY.md'
  })
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.uploads(), 0)
})

test('valid control writes preserve zero generations and ignore client-supplied actor identity', async (t) => {
  const fixture = await memoryWriteFixture(t)
  for (const action of ['pause', 'resume'] as const) {
    const body = { ...validMemoryWrites[action], expected_generation: 0 }
    const response = await fixture.post(
      action,
      JSON.stringify({ ...body, actor: { kind: 'operator', id: 'forged' } })
    )
    assert.equal(response.status, 201)
    assert.deepEqual(fixture.writes.at(-1), {
      path: `/v1/maintenance-control/${action}`,
      body
    })
  }
  assert.equal(fixture.uploads(), 0)
})

test('an initial memory edit accepts revision zero and reserves before uploading', async (t) => {
  const fixture = await memoryWriteFixture(t)
  const response = await fixture.post(
    'edit',
    JSON.stringify(validMemoryWrites.edit)
  )
  assert.equal(response.status, 201)
  assert.equal(fixture.uploads(), 1)
  assert.deepEqual(
    fixture.writes.map(({ path }) => path),
    [
      '/v1/memory-tree/revisions/publications/reserve',
      '/v1/memory-tree/revisions/publications/confirm',
      '/v1/memory-tree/revisions'
    ]
  )
  const body = fixture.writes[0]?.body
  assert(body && typeof body === 'object' && 'expected_active_revision' in body)
  assert.equal(body.expected_active_revision, 0)
})

test('valid edits keep upload capability errors separate from malformed input', async (t) => {
  const fixture = await memoryWriteFixture(t, { upload: 'missing' })
  const invalid = await fixture.post('edit', 'null')
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'invalid_request' })
  const response = await fixture.post(
    'edit',
    JSON.stringify(validMemoryWrites.edit)
  )
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: 'memory_artifact_upload_unavailable'
  })
  assert.deepEqual(fixture.writes, [])
})

test('memory edits report upload failures as 502 and do not confirm or commit', async (t) => {
  const fixture = await memoryWriteFixture(t, { upload: 'fails' })
  const response = await fixture.post(
    'edit',
    JSON.stringify(validMemoryWrites.edit)
  )
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), {
    error: 'memory_artifact_upload_failed'
  })
  assert.equal(fixture.uploads(), 1)
  assert.deepEqual(
    fixture.writes.map(({ path }) => path),
    ['/v1/memory-tree/revisions/publications/reserve']
  )
})

test('valid memory edits relay Catalog conflicts before uploading', async (t) => {
  const fixture = await memoryWriteFixture(t, { catalogStatus: 409 })
  const response = await fixture.post(
    'edit',
    JSON.stringify(validMemoryWrites.edit)
  )
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'revision_conflict' })
  assert.equal(fixture.uploads(), 0)
  assert.equal(fixture.writes.length, 1)
})

for (const failedPhase of ['reserve', 'confirm', 'commit'] as const) {
  test(`memory edits stop at a failed ${failedPhase} and relay its response`, async (t) => {
    const paths = [
      '/v1/memory-tree/revisions/publications/reserve',
      '/v1/memory-tree/revisions/publications/confirm',
      '/v1/memory-tree/revisions'
    ]
    const failedIndex = { reserve: 0, confirm: 1, commit: 2 }[failedPhase]
    const fixture = await memoryWriteFixture(t, {
      catalogStatus: 409,
      catalogFailurePath: paths[failedIndex]
    })
    const response = await fixture.post(
      'edit',
      JSON.stringify(validMemoryWrites.edit)
    )
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'revision_conflict' })
    assert.equal(fixture.uploads(), failedPhase === 'reserve' ? 0 : 1)
    assert.deepEqual(
      fixture.writes.map(({ path }) => path),
      paths.slice(0, failedIndex + 1)
    )
    for (const { body } of fixture.writes)
      assert.deepEqual(body, fixture.writes[0]?.body)
  })
}
