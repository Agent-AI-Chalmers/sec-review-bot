import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

test('S3 input upload is immutable and idempotent', async (t) => {
  const endpoint = process.env['SEC_REVIEW_TEST_S3_ENDPOINT']
  const bucket = process.env['SEC_REVIEW_TEST_S3_BUCKET']
  if (!endpoint || !bucket) return t.skip('S3 integration environment is not configured.')

  process.env['SEC_REVIEW_ARTIFACT_STORE'] = 's3'
  process.env['SEC_REVIEW_ARTIFACT_S3_ENDPOINT'] = endpoint
  process.env['SEC_REVIEW_ARTIFACT_S3_BUCKET'] = bucket
  const { publishInputBundle } = await import('../../../src/infrastructure/artifacts/input-storage.js')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 's3-input-storage-'))
  const source = path.join(directory, 'input-bundle.tar.zst')
  const content = Buffer.from('s3-integration-input-bundle')
  await fs.writeFile(source, content)
  const reference = {
    uri: pathToFileURL(source).href,
    digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}` as `sha256:${string}`,
    media_type: 'application/vnd.sec-review.input-bundle.v1+tar+zstd' as const,
    size_bytes: content.byteLength
  }
  const runId = `integration-${crypto.randomBytes(8).toString('hex')}`

  const key = `runs/${runId}/input/input-bundle.v1.tar.zst`
  try {
    const first = await publishInputBundle(reference, runId)
    const retry = await publishInputBundle(reference, runId)
    assert.equal(first.uri, retry.uri)
    assert.equal(first.uri, `s3://${bucket}/${key}`)

    await fs.writeFile(source, 'different')
    await assert.rejects(
      publishInputBundle({ ...reference, size_bytes: 9 }, runId),
      /conflicts with existing content/
    )
  } finally {
    const cleanupAccessKeyId = process.env['SEC_REVIEW_TEST_S3_CLEANUP_ACCESS_KEY_ID']
    const cleanupSecretAccessKey = process.env['SEC_REVIEW_TEST_S3_CLEANUP_SECRET_ACCESS_KEY']
    if (cleanupAccessKeyId && cleanupSecretAccessKey) {
      // Production integration credentials intentionally cannot delete artifacts.
      const client = new S3Client({
        endpoint,
        region: process.env['AWS_REGION'] || 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: cleanupAccessKeyId, secretAccessKey: cleanupSecretAccessKey }
      })
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    }
  }
})
