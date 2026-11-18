import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { pathToFileURL } from 'node:url'

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

const endpoint = process.env['SEC_REVIEW_TEST_S3_ENDPOINT']
const bucket = process.env['SEC_REVIEW_TEST_S3_BUCKET']

test.skipIf(!endpoint || !bucket)(
  'S3 input upload is immutable and idempotent',
  async () => {
    if (!endpoint || !bucket)
      throw new Error('S3 integration environment is not configured.')

    process.env['SEC_REVIEW_ARTIFACT_STORE'] = 's3'
    process.env['SEC_REVIEW_ARTIFACT_S3_ENDPOINT'] = endpoint
    process.env['SEC_REVIEW_ARTIFACT_S3_BUCKET'] = bucket
    const {
      publishInputBundle,
      inputBundleExists,
      publishedInputBundleReference
    } = await import('../../../src/artifacts/input-storage.js')
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 's3-input-storage-')
    )
    const source = path.join(directory, 'input-bundle.tar.zst')
    const content = Buffer.from('s3-integration-input-bundle')
    await fs.writeFile(source, content)
    const reference = {
      uri: pathToFileURL(source).href,
      digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
      media_type: 'application/tar+zstd' as const,
      size_bytes: content.byteLength
    }
    const runId = `integration-${crypto.randomBytes(8).toString('hex')}`

    const key = `runs/${runId}/input/${reference.digest.slice(7)}/input-bundle.v1.tar.zst`
    try {
      expect(
        await inputBundleExists(publishedInputBundleReference(reference, runId))
      ).toBe(false)
      const first = await publishInputBundle(reference, runId)
      expect(await inputBundleExists(first)).toBe(true)
      const retry = await publishInputBundle(reference, runId)
      expect(first.uri).toBe(retry.uri)
      expect(first.uri).toBe(`s3://${bucket}/${key}`)

      await fs.writeFile(source, 'different')
      await expect(
        publishInputBundle({ ...reference, size_bytes: 9 }, runId)
      ).rejects.toThrow(/conflicts with existing content/)
    } finally {
      const cleanupAccessKeyId =
        process.env['SEC_REVIEW_TEST_S3_CLEANUP_ACCESS_KEY_ID']
      const cleanupSecretAccessKey =
        process.env['SEC_REVIEW_TEST_S3_CLEANUP_SECRET_ACCESS_KEY']
      if (cleanupAccessKeyId && cleanupSecretAccessKey) {
        // Production integration credentials intentionally cannot delete artifacts.
        const client = new S3Client({
          endpoint,
          region: process.env['AWS_REGION'] || 'us-east-1',
          forcePathStyle: true,
          credentials: {
            accessKeyId: cleanupAccessKeyId,
            secretAccessKey: cleanupSecretAccessKey
          }
        })
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      }
    }
  }
)
