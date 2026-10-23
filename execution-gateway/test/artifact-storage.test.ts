import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'
import { createZstdDecompress } from 'node:zlib'

import { S3Client } from '@aws-sdk/client-s3'
import tar from 'tar-stream'

import {
  createDiagnosticArchive,
  publishDiagnosticArtifact,
} from '../src/artifact-storage.js'

await test('missing terminal artifact roots are reported as unavailable', async () => {
  assert.deepEqual(
    await publishDiagnosticArtifact('/path/that/does/not/exist', 'run-missing'),
    { status: 'unavailable' },
  )
})

await test('diagnostic archives use Node zstd and preserve file contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-artifact-test-'))
  const source = path.join(root, 'source')
  const archive = path.join(root, 'artifact.tar.zst')
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(path.join(source, 'nested'), { recursive: true }),
  )
  await writeFile(path.join(source, 'nested', 'result.txt'), 'review result')

  try {
    await createDiagnosticArchive(source, archive)
    const extract = tar.extract()
    const entries = new Map<string, string>()
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: unknown) => {
        assert.ok(Buffer.isBuffer(chunk))
        chunks.push(chunk)
      })
      stream.on('end', () => {
        if (header.type === 'file') {
          entries.set(header.name, Buffer.concat(chunks).toString('utf8'))
        }
        next()
      })
      stream.resume()
    })
    await pipeline(createReadStream(archive), createZstdDecompress(), extract)
    assert.equal(
      entries.get('artifact-tree/nested/result.txt'),
      'review result',
    )
    assert.ok((await readFile(archive)).byteLength > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('existing diagnostic artifacts are reused from immutable metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-artifact-test-'))
  const previous = {
    bucket: process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
  process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET = 'artifacts'
  process.env.AWS_ACCESS_KEY_ID = 'test'
  process.env.AWS_SECRET_ACCESS_KEY = 'test'
  t.mock.method(S3Client.prototype, 'send', () =>
    Promise.resolve({
      Metadata: { sha256: 'a'.repeat(64), 'size-bytes': '42' },
      ContentLength: 42,
      ContentType: 'application/tar+zstd',
    }),
  )

  try {
    assert.deepEqual(await publishDiagnosticArtifact(root, 'run-existing'), {
      status: 'available',
      artifact: {
        kind: 'diagnostic_bundle',
        uri: 's3://artifacts/runs/run-existing/artifacts/diagnostic-tree.v1.tar.zst',
        media_type: 'application/tar+zstd',
        digest: `sha256:${'a'.repeat(64)}`,
        size_bytes: 42,
      },
    })
  } finally {
    if (previous.bucket === undefined)
      delete process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET
    else process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET = previous.bucket
    if (previous.accessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID
    else process.env.AWS_ACCESS_KEY_ID = previous.accessKey
    if (previous.secretKey === undefined)
      delete process.env.AWS_SECRET_ACCESS_KEY
    else process.env.AWS_SECRET_ACCESS_KEY = previous.secretKey
    await rm(root, { recursive: true, force: true })
  }
})

await test('existing diagnostic artifacts require complete immutable metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-artifact-test-'))
  const previous = {
    bucket: process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
  process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET = 'artifacts'
  process.env.AWS_ACCESS_KEY_ID = 'test'
  process.env.AWS_SECRET_ACCESS_KEY = 'test'
  t.mock.method(S3Client.prototype, 'send', () =>
    Promise.resolve({
      Metadata: { sha256: 'a'.repeat(64), 'size-bytes': '42' },
      ContentLength: 42,
    }),
  )

  try {
    await assert.rejects(
      publishDiagnosticArtifact(root, 'run-incomplete'),
      /invalid immutable metadata/,
    )
  } finally {
    restoreStorageEnvironment(previous)
    await rm(root, { recursive: true, force: true })
  }
})

await test('precondition conflicts reuse only the same immutable object', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gateway-artifact-test-'))
  await writeFile(path.join(root, 'result.txt'), 'review result')
  const previous = {
    bucket: process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
  process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET = 'artifacts'
  process.env.AWS_ACCESS_KEY_ID = 'test'
  process.env.AWS_SECRET_ACCESS_KEY = 'test'
  let call = 0
  let uploadedMetadata: Record<string, string> | undefined
  let uploadedContentType: string | undefined
  t.mock.method(S3Client.prototype, 'send', (command: unknown) => {
    call += 1
    if (call === 1)
      return Promise.reject(
        Object.assign(new Error('not found'), {
          $metadata: { httpStatusCode: 404 },
        }),
      )
    if (call === 2) {
      const input = (
        command as {
          input: {
            Metadata?: Record<string, string>
            ContentType?: string
          }
        }
      ).input
      uploadedMetadata = input.Metadata
      uploadedContentType = input.ContentType
      return Promise.reject(
        Object.assign(new Error('precondition failed'), {
          $metadata: { httpStatusCode: 412 },
        }),
      )
    }
    const size = Number(uploadedMetadata?.['size-bytes'])
    return Promise.resolve({
      Metadata: uploadedMetadata,
      ContentLength: size,
      ContentType: uploadedContentType,
    })
  })

  try {
    const projection = await publishDiagnosticArtifact(root, 'run-conflict')
    assert.equal(projection.status, 'available')
    assert.equal(call, 3)
  } finally {
    restoreStorageEnvironment(previous)
    await rm(root, { recursive: true, force: true })
  }
})

function restoreStorageEnvironment(previous: {
  bucket: string | undefined
  accessKey: string | undefined
  secretKey: string | undefined
}): void {
  if (previous.bucket === undefined)
    delete process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET
  else process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET = previous.bucket
  if (previous.accessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID
  else process.env.AWS_ACCESS_KEY_ID = previous.accessKey
  if (previous.secretKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
  else process.env.AWS_SECRET_ACCESS_KEY = previous.secretKey
}
