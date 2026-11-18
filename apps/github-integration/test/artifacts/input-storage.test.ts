import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, beforeEach, beforeAll, test } from 'vitest'
import { pathToFileURL } from 'node:url'

import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'

const s3 = mockClient(S3Client)

beforeAll(() => {
  process.env['SEC_REVIEW_ARTIFACT_STORE'] = 's3'
  process.env['SEC_REVIEW_ARTIFACT_S3_BUCKET'] = 'sec-review'
  process.env['AWS_REGION'] = 'us-east-1'
})

beforeEach(() => {
  s3.reset()
  s3.on(ListObjectsV2Command).resolves({ Contents: [] })
})

async function reference() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'input-storage-'))
  const source = path.join(directory, 'bundle.tar.zst')
  await fs.writeFile(source, 'bundle')
  return {
    uri: pathToFileURL(source).href,
    digest: `sha256:${'a'.repeat(64)}`,
    media_type: 'application/tar+zstd' as const,
    size_bytes: 6
  }
}

test('uploads an immutable input bundle to its deterministic run key', async () => {
  s3.on(HeadObjectCommand).rejects(
    Object.assign(new Error('not found'), {
      $metadata: { httpStatusCode: 404 }
    })
  )
  s3.on(PutObjectCommand).resolves({})
  const { publishInputBundle } =
    await import('../../src/artifacts/input-storage.js')

  const published = await publishInputBundle(await reference(), 'run-123')

  expect(published.uri).toBe(
    `s3://sec-review/runs/run-123/input/${'a'.repeat(64)}/input-bundle.v1.tar.zst`
  )
  expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1)
  expect(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.IfNoneMatch).toBe(
    '*'
  )
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
  const { publishInputBundle } =
    await import('../../src/artifacts/input-storage.js')

  const published = await publishInputBundle(input, 'run-123')

  expect(published.uri).toMatch(/^s3:/)
  expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0)
})

test('rejects conflicting content at the immutable run key', async () => {
  s3.on(HeadObjectCommand).resolves({ ContentLength: 99, Metadata: {} })
  const { publishInputBundle } =
    await import('../../src/artifacts/input-storage.js')

  await expect(
    publishInputBundle(await reference(), 'run-123')
  ).rejects.toThrow(/conflicts with existing content/)
})

test('a concurrent identical conditional write is recovered after a 412', async () => {
  const input = await reference()
  let heads = 0
  s3.on(HeadObjectCommand).callsFake(() => {
    if (heads++ === 0)
      throw Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: 404 }
      })
    return {
      ContentLength: input.size_bytes,
      Metadata: {
        sha256: input.digest.slice(7),
        'media-type': input.media_type
      }
    }
  })
  s3.on(PutObjectCommand).rejects(
    Object.assign(new Error('already uploaded'), {
      $metadata: { httpStatusCode: 412 }
    })
  )
  const { publishInputBundle } =
    await import('../../src/artifacts/input-storage.js')
  const result = await publishInputBundle(input, 'run')
  expect(result.uri).toMatch(/^s3:/)
  expect(heads).toBe(2)
})

for (const status of [403, 404]) {
  test(`scoped listing establishes absence after HEAD ${status}`, async () => {
    const input = await reference()
    const { inputBundleExists, publishedInputBundleReference } =
      await import('../../src/artifacts/input-storage.js')
    const published = publishedInputBundleReference(input, 'run')
    const key = new URL(published.uri).pathname.slice(1)
    s3.on(HeadObjectCommand).rejects(
      Object.assign(new Error('ambiguous HEAD'), {
        $metadata: { httpStatusCode: status }
      })
    )
    s3.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: key + '.other' }]
    })
    expect(await inputBundleExists(published)).toBe(false)
    expect(
      s3.commandCalls(ListObjectsV2Command)[0]?.args[0].input
    ).toStrictEqual({
      Bucket: 'sec-review',
      Prefix: key,
      MaxKeys: 1
    })
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: key }] })
    await expect(inputBundleExists(published)).rejects.toThrow(/ambiguous HEAD/)
    s3.on(ListObjectsV2Command).rejects(new Error('listing denied'))
    await expect(inputBundleExists(published)).rejects.toThrow(/listing denied/)
  })
}
