import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'

const s3 = mockClient(S3Client)

test.before(() => {
  process.env['SEC_REVIEW_ARTIFACT_STORE'] = 's3'
  process.env['SEC_REVIEW_ARTIFACT_S3_BUCKET'] = 'sec-review'
  process.env['AWS_REGION'] = 'us-east-1'
})

test.beforeEach(() => s3.reset())

async function reference () {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'input-storage-'))
  const source = path.join(directory, 'bundle.tar.zst')
  await fs.writeFile(source, 'bundle')
  return {
    uri: pathToFileURL(source).href,
    digest: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
    media_type: 'application/vnd.sec-review.input-bundle.v1+tar+zstd' as const,
    size_bytes: 6
  }
}

test('uploads an immutable input bundle to its deterministic run key', async () => {
  s3.on(HeadObjectCommand).rejects(Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } }))
  s3.on(PutObjectCommand).resolves({})
  const { publishInputBundle } = await import('../../infrastructure/artifacts/input-storage.js')

  const published = await publishInputBundle(await reference(), 'run-123')

  assert.equal(published.uri, 's3://sec-review/runs/run-123/input/input-bundle.v1.tar.zst')
  assert.equal(s3.commandCalls(PutObjectCommand).length, 1)
  assert.equal(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.IfNoneMatch, '*')
})

test('reuses an existing object only when immutable metadata matches', async () => {
  const input = await reference()
  s3.on(HeadObjectCommand).resolves({
    ContentLength: input.size_bytes,
    Metadata: {
      sha256: input.digest.replace(/^sha256:/, ''),
      'media-type': input.media_type
    }
  })
  const { publishInputBundle } = await import('../../infrastructure/artifacts/input-storage.js')

  const published = await publishInputBundle(input, 'run-123')

  assert.match(published.uri, /^s3:/)
  assert.equal(s3.commandCalls(PutObjectCommand).length, 0)
})

test('rejects conflicting content at the immutable run key', async () => {
  s3.on(HeadObjectCommand).resolves({ ContentLength: 99, Metadata: {} })
  const { publishInputBundle } = await import('../../infrastructure/artifacts/input-storage.js')

  await assert.rejects(
    publishInputBundle(await reference(), 'run-123'),
    /conflicts with existing content/
  )
})
