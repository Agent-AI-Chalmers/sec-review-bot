import { Readable } from 'node:stream'

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'

export const ARTIFACT_BUCKET = 'sec-review'

export interface ArtifactStore {
  getObject(
    key: string,
    signal: AbortSignal
  ): Promise<{ body: Readable; contentLength?: number }>
  putMemoryArtifact?(artifact: {
    bytes: Buffer
    digest: string
    mediaType: string
    objectKey: string
    sizeBytes: number
  }): Promise<void>
}

export function artifactStorageStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const metadata = '$metadata' in error ? error.$metadata : undefined
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('httpStatusCode' in metadata)
  )
    return undefined
  return typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined
}

/** Build the production S3 adapter only when artifact storage is configured. */
export function artifactStoreFromEnvironment(): ArtifactStore | undefined {
  const endpoint = process.env.SEC_REVIEW_ARTIFACT_S3_ENDPOINT?.trim()
  const bucket = process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET?.trim()
  const addressingStyle =
    process.env.SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE?.trim() || 'auto'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!endpoint && !bucket) return undefined
  if (
    bucket !== ARTIFACT_BUCKET ||
    !accessKeyId ||
    !secretAccessKey ||
    !['auto', 'path', 'virtual'].includes(addressingStyle)
  )
    throw new Error(
      'Control Plane UI artifact storage configuration is invalid.'
    )
  const client = new S3Client({
    ...(endpoint ? { endpoint } : {}),
    region: process.env.AWS_REGION ?? 'us-east-1',
    // Omitting forcePathStyle preserves the SDK's native endpoint behavior for auto mode.
    ...(addressingStyle === 'auto'
      ? {}
      : { forcePathStyle: addressingStyle === 'path' }),
    credentials: { accessKeyId, secretAccessKey }
  })
  return {
    async getObject(
      key,
      signal
    ): Promise<{ body: Readable; contentLength?: number }> {
      const object = await client.send(
        new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }),
        { abortSignal: signal }
      )
      if (!(object.Body instanceof Readable))
        throw new Error('RustFS returned no readable body.')
      return {
        body: object.Body,
        ...(object.ContentLength === undefined
          ? {}
          : { contentLength: object.ContentLength })
      }
    },
    async putMemoryArtifact(artifact): Promise<void> {
      try {
        const existing = await client.send(
          new HeadObjectCommand({
            Bucket: ARTIFACT_BUCKET,
            Key: artifact.objectKey
          })
        )
        if (
          existing.ContentLength !== artifact.sizeBytes ||
          existing.ContentType !== artifact.mediaType ||
          existing.Metadata?.sha256 !== artifact.digest.slice('sha256:'.length)
        )
          throw new Error('memory_artifact_identity_mismatch')
        return
      } catch (error) {
        if (artifactStorageStatus(error) !== 404) throw error
      }
      await client.send(
        new PutObjectCommand({
          Bucket: ARTIFACT_BUCKET,
          Key: artifact.objectKey,
          Body: artifact.bytes,
          ContentType: artifact.mediaType,
          IfNoneMatch: '*',
          Metadata: {
            sha256: artifact.digest.slice('sha256:'.length),
            'size-bytes': String(artifact.sizeBytes)
          }
        })
      )
    }
  }
}
