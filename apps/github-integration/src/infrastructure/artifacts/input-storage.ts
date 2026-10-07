import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'

import {
  artifact_s3_bucket,
  artifact_s3_endpoint,
  artifact_s3_region,
  artifact_store
} from '../../config.js'
import type { InputBundleArtifactRef } from '../runner/input.js'

function inputObjectKey (runId: string): string {
  return `runs/${runId}/input/input-bundle.v1.tar.zst`
}

function configuredClient (): S3Client {
  return new S3Client({
    region: artifact_s3_region,
    ...(artifact_s3_endpoint
      ? { endpoint: artifact_s3_endpoint, forcePathStyle: true }
      : {})
  })
}

function matchesReference (
  response: {
    ContentLength?: number | undefined
    Metadata?: Record<string, string> | undefined
  },
  reference: InputBundleArtifactRef
): boolean {
  return response.ContentLength === reference.size_bytes &&
    response.Metadata?.['sha256'] === reference.digest.replace(/^sha256:/, '') &&
    response.Metadata?.['media-type'] === reference.media_type
}

async function existingObjectMatches (
  client: S3Client,
  bucket: string,
  key: string,
  reference: InputBundleArtifactRef
): Promise<boolean | undefined> {
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return matchesReference(response, reference)
  } catch (error) {
    const status = typeof error === 'object' && error !== null && '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined
    if (status === 404) return undefined
    throw error
  }
}

export async function publishInputBundle (
  reference: InputBundleArtifactRef,
  runId: string
): Promise<InputBundleArtifactRef> {
  if (artifact_store === 'file') return reference
  if (!artifact_s3_bucket) {
    throw new Error('SEC_REVIEW_ARTIFACT_S3_BUCKET is required for the S3 artifact store.')
  }

  const source = new URL(reference.uri)
  if (source.protocol !== 'file:') {
    throw new Error('Input bundle publication requires a local file reference.')
  }
  const key = inputObjectKey(runId)
  const client = configuredClient()
  const existing = await existingObjectMatches(client, artifact_s3_bucket, key, reference)
  if (existing === true) {
    return { ...reference, uri: `s3://${artifact_s3_bucket}/${key}` }
  }
  if (existing === false) {
    throw new Error(`Immutable input bundle object conflicts with existing content: ${key}`)
  }

  try {
    await client.send(new PutObjectCommand({
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
    }))
  } catch (error) {
    const status = typeof error === 'object' && error !== null && '$metadata' in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined
    if (status !== 412 || await existingObjectMatches(client, artifact_s3_bucket, key, reference) !== true) {
      throw error
    }
  }
  return { ...reference, uri: `s3://${artifact_s3_bucket}/${key}` }
}
