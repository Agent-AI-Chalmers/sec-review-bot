import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createControlPlaneUiBffServer } from '../server/create-bff.js'
import { diagnosticBundle, loginCookie } from './server-support.js'

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
  const ui = createControlPlaneUiBffServer({
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
      headers: { origin: base },
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
  const ui = createControlPlaneUiBffServer({
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
  const ui = createControlPlaneUiBffServer({
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
      headers: { origin: base },
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
  const ui = createControlPlaneUiBffServer({
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
      headers: { origin: base },
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
  const ui = createControlPlaneUiBffServer({
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
      headers: { origin: base },
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
  const ui = createControlPlaneUiBffServer({
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
      headers: { origin: base },
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
  const ui = createControlPlaneUiBffServer({
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
      headers: { origin: base },
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

test('BFF lets a progressing artifact preview outlive the metadata timeout', async () => {
  const runId = 'run-1'
  const bundle = await diagnosticBundle(runId)
  const digest = `sha256:${crypto.createHash('sha256').update(bundle).digest('hex')}`
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
              digest,
              size_bytes: bundle.length
            }
          }
        }
      })
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')

  let started = false
  const body = new Readable({
    read(): void {
      if (started) return
      started = true
      this.push(bundle.subarray(0, 1))
      setTimeout(() => {
        this.push(bundle.subarray(1))
        this.push(null)
      }, 1000)
    }
  })
  const ui = createControlPlaneUiBffServer({
    reviewRunsUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    reviewRunsToken: 'read-secret',
    accessToken: 'login-secret',
    reviewRunsRequestTimeoutMs: 500,
    artifactDownloadIdleTimeoutMs: 3000,
    artifactStore: {
      async getObject(): Promise<{ body: Readable; contentLength: number }> {
        return { body, contentLength: bundle.length }
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
    assert.strictEqual(response.status, 200)
    const view = (await response.json()) as {
      files: Record<string, string>
    }
    assert.strictEqual(view.files['manifest.json']?.includes('unit-1'), true)
  } finally {
    upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => ui.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve()))
    ])
  }
})
