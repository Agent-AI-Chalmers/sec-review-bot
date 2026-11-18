import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException
} from '@aws-sdk/client-s3'

function requiredEnv(name: string): string {
  const value = process.env[name]
  assert.ok(value, `${name} is required`)
  return value
}

function client(role: 'INTEGRATION' | 'EXECUTION') {
  return new S3Client({
    endpoint: 'http://rustfs:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 2,
    credentials: {
      accessKeyId: requiredEnv(`SEC_REVIEW_${role}_S3_ACCESS_KEY`),
      secretAccessKey: requiredEnv(`SEC_REVIEW_${role}_S3_SECRET_KEY`)
    }
  })
}

const corpus = '/smoke/input-bundle-corpus'
const { corpus: cases } = JSON.parse(readFileSync(`${corpus}/manifest.json`, 'utf8')) as {
  corpus: { file: string; sha256: string; size: number }[]
}
const fixture = cases.find((entry) => entry.file === 'valid-minimal.tar.zst')
assert.ok(fixture, 'Minimal input-bundle fixture is required')
const payload = readFileSync(`${corpus}/${fixture.file}`)
const digest = createHash('sha256').update(payload).digest('hex')
assert.equal(digest, fixture.sha256)
assert.equal(payload.length, fixture.size)
const { record } = JSON.parse(requiredEnv('SMOKE_ADMISSION')) as {
  record: { run_id: string }
}
const Bucket = 'sec-review'
const Key = `runs/${record.run_id}/input/${digest}/input-bundle.v1.tar.zst`
const ContentType = 'application/tar+zstd'
const writer = client('INTEGRATION')
const reader = client('EXECUTION')

try {
  await writer.send(new PutObjectCommand({ Bucket, Key, Body: payload, ContentType }), {
    abortSignal: AbortSignal.timeout(15000)
  })
  console.error('ok: Integration identity uploaded the input bundle')
  const response = await reader.send(new GetObjectCommand({ Bucket, Key }), {
    abortSignal: AbortSignal.timeout(15000)
  })
  assert.ok(response.Body, 'S3 response body is required')
  const downloaded = Buffer.from(await response.Body.transformToByteArray())
  assert.equal(response.ContentType, ContentType)
  assert.equal(response.ContentLength, payload.length)
  assert.deepEqual(downloaded, payload)
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), digest)
  console.error('ok: Execution identity downloaded matching bytes, size, and digest')

  await assert.rejects(
    reader.send(new PutObjectCommand({ Bucket, Key, Body: payload }), {
      abortSignal: AbortSignal.timeout(15000)
    }),
    (error: unknown) =>
      error instanceof S3ServiceException &&
      error.$metadata.httpStatusCode === 403 &&
      error.name === 'AccessDenied',
    'Execution identity must not write input bundles'
  )
  console.error('ok: Execution identity cannot write the input prefix')

  // stdout is reserved for the verified reference consumed by the HTTP probe.
  console.log(
    JSON.stringify({
      uri: `s3://${Bucket}/${Key}`,
      digest: `sha256:${digest}`,
      media_type: ContentType,
      size_bytes: payload.length
    })
  )
} finally {
  writer.destroy()
  reader.destroy()
}
