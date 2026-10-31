import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'

import {
  artifact_s3_addressing_style,
  artifact_s3_bucket,
  artifact_s3_endpoint,
  artifact_s3_region,
  artifact_store
} from '../config.js'
import type { InputBundleArtifactRef } from '../execution/input.js'

function inputObjectKey(runId: string, digest: string): string {
  return `runs/${runId}/input/${digest.replace(/^sha256:/, '')}/input-bundle.v1.tar.zst`
}

function configuredClient(): S3Client {
  return new S3Client({
    region: artifact_s3_region,
    ...(artifact_s3_endpoint ? { endpoint: artifact_s3_endpoint } : {}),
    // Omitting forcePathStyle preserves the SDK's native endpoint behavior for auto mode.
    ...(artifact_s3_addressing_style === 'auto'
      ? {}
      : { forcePathStyle: artifact_s3_addressing_style === 'path' })
  })
}

function matchesReference(
  response: {
    ContentLength?: number | undefined
    Metadata?: Record<string, string> | undefined
  },
  reference: InputBundleArtifactRef
): boolean {
  return (
    response.ContentLength === reference.size_bytes &&
    response.Metadata?.['sha256'] ===
      reference.digest.replace(/^sha256:/, '') &&
    response.Metadata?.['media-type'] === reference.media_type
  )
}

async function existingObjectMatches(
  client: S3Client,
  bucket: string,
  key: string,
  reference: InputBundleArtifactRef
): Promise<boolean | undefined> {
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    )
    return matchesReference(response, reference)
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && '$metadata' in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode
        : undefined
    if (status === 404) return undefined
    throw error
  }
}

/**
 * The reference a local bundle will have once published.
 *
 * The bucket and key are known before the upload, so a caller can build and size the workflow
 * input against the URI that will actually be submitted, and refuse an oversized input before
 * anything is written to object storage.
 */
export function publishedInputBundleReference(
  reference: InputBundleArtifactRef,
  runId: string
): InputBundleArtifactRef {
  if (artifact_store === 'file') return reference
  const key = inputObjectKey(runId, reference.digest)
  return { ...reference, uri: `s3://${artifact_s3_bucket}/${key}` }
}

export async function publishInputBundle(
  reference: InputBundleArtifactRef,
  runId: string
): Promise<InputBundleArtifactRef> {
  if (artifact_store === 'file') return reference
  if (!artifact_s3_bucket) {
    throw new Error(
      'SEC_REVIEW_ARTIFACT_S3_BUCKET is required for the S3 artifact store.'
    )
  }

  const source = new URL(reference.uri)
  if (source.protocol !== 'file:') {
    throw new Error('Input bundle publication requires a local file reference.')
  }
  const key = inputObjectKey(runId, reference.digest)
  const client = configuredClient()
  const existing = await existingObjectMatches(
    client,
    artifact_s3_bucket,
    key,
    reference
  )
  if (existing === true) {
    return publishedInputBundleReference(reference, runId)
  }
  if (existing === false) {
    throw new Error(
      `Immutable input bundle object conflicts with existing content: ${key}`
    )
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: artifact_s3_bucket,
        Key: key,
        Body: createReadStream(fileURLToPath(source)),
        ContentLength: reference.size_bytes,
        ContentType: reference.media_type,
        IfNoneMatch: '*',
        Metadata: {
          sha256: reference.digest.replace(/^sha256:/, ''),
          'media-type': reference.media_type
        }
      })
    )
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && '$metadata' in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode
        : undefined
    if (
      status !== 412 ||
      (await existingObjectMatches(
        client,
        artifact_s3_bucket,
        key,
        reference
      )) !== true
    ) {
      throw error
    }
  }
  return { ...reference, uri: `s3://${artifact_s3_bucket}/${key}` }
}

/** A failed read is uncertainty, not absence. Only a definitive missing object returns false. */
export async function inputBundleExists(
  reference: InputBundleArtifactRef
): Promise<boolean> {
  const uri = new URL(reference.uri)
  if (uri.protocol === 'file:') {
    try {
      const source = fileURLToPath(uri)
      const { size } = await fs.stat(source)
      const digest = createHash('sha256')
      await pipeline(createReadStream(source), digest)
      if (
        size !== reference.size_bytes ||
        `sha256:${digest.digest('hex')}` !== reference.digest
      )
        throw new Error('Local input bundle differs from its immutable intent.')
      return true
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false
      throw error
    }
  }
  if (uri.protocol !== 's3:' || uri.hostname !== artifact_s3_bucket)
    throw new Error('Input bundle uses an unconfigured store.')
  const matches = await existingObjectMatches(
    configuredClient(),
    uri.hostname,
    uri.pathname.slice(1),
    reference
  )
  if (matches === false)
    throw new Error('Input bundle object differs from its immutable intent.')
  return matches === true
}
