import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress } from 'node:zlib'

import {
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import tar from 'tar-stream'

const mediaType = 'application/tar+zstd'

export interface ArtifactStorageProjection {
  status: 'available' | 'unavailable' | 'failed'
  artifact?: {
    kind: 'diagnostic_bundle'
    uri: string
    media_type: string
    digest: string
    size_bytes: number
  }
  error_code?: string
  message?: string
}

async function digestFile(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file))
    digest.update(chunk as Buffer)
  return digest.digest('hex')
}

function configuredClient(): { client: S3Client; bucket: string } {
  const bucket = process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET?.trim()
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('Artifact storage configuration is incomplete.')
  }
  return {
    bucket,
    client: new S3Client({
      ...(process.env.SEC_REVIEW_ARTIFACT_S3_ENDPOINT?.trim()
        ? { endpoint: process.env.SEC_REVIEW_ARTIFACT_S3_ENDPOINT.trim() }
        : {}),
      forcePathStyle: true,
      region: process.env.AWS_REGION?.trim() || 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
    }),
  }
}

export async function publishDiagnosticArtifact(
  artifactRoot: string,
  runId: string,
): Promise<ArtifactStorageProjection> {
  if (!existsSync(artifactRoot)) return { status: 'unavailable' }
  const { client, bucket } = configuredClient()
  const key = `runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
  try {
    const existing = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    )
    const identity = immutableIdentity(existing)
    if (!identity)
      throw new Error(
        'Existing diagnostic artifact has invalid immutable metadata.',
      )
    return available(bucket, key, identity.digest, identity.size)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'execution-artifact-'),
  )
  const archive = path.join(temporaryRoot, 'diagnostic-tree.v1.tar.zst')
  try {
    await createDiagnosticArchive(artifactRoot, archive)
    const digest = await digestFile(archive)
    const size = (await stat(archive)).size
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(archive),
          ContentType: mediaType,
          Metadata: { sha256: digest, 'size-bytes': String(size) },
          IfNoneMatch: '*',
        }),
      )
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error
      const existing = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      )
      const identity = immutableIdentity(existing)
      if (!identity || identity.digest !== digest || identity.size !== size) {
        throw new Error(
          'Existing diagnostic artifact has different immutable metadata.',
          { cause: error },
        )
      }
    }
    return available(bucket, key, digest, size)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function immutableIdentity(
  object: HeadObjectCommandOutput,
): { digest: string; size: number } | undefined {
  const digest = object.Metadata?.sha256
  const size = Number.parseInt(object.Metadata?.['size-bytes'] ?? '', 10)
  if (
    !digest ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    object.ContentLength !== size ||
    object.ContentType !== mediaType
  ) {
    return undefined
  }
  return { digest, size }
}

export async function createDiagnosticArchive(
  root: string,
  destination: string,
): Promise<void> {
  const pack = tar.pack()
  const writing = pipeline(
    pack,
    createZstdCompress(),
    createWriteStream(destination),
  )
  await addDirectory(pack, root, 'artifact-tree')
  pack.finalize()
  await writing
}

async function addDirectory(
  pack: tar.Pack,
  source: string,
  archivePath: string,
): Promise<void> {
  await addEntry(pack, archivePath, { type: 'directory', mode: 0o755 })
  for (const name of (await readdir(source)).sort()) {
    const childSource = path.join(source, name)
    const childArchive = `${archivePath}/${name}`
    const metadata = await lstat(childSource)
    if (metadata.isSymbolicLink()) continue
    if (metadata.isDirectory()) {
      await addDirectory(pack, childSource, childArchive)
    } else if (metadata.isFile()) {
      await addEntry(
        pack,
        childArchive,
        { type: 'file', mode: metadata.mode, size: metadata.size },
        await readFile(childSource),
      )
    }
  }
}

async function addEntry(
  pack: tar.Pack,
  name: string,
  header: Omit<Partial<tar.Header>, 'name'>,
  body?: Buffer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const completed = (error?: Error | null): void => {
      if (error) reject(error)
      else resolve()
    }
    if (body === undefined) pack.entry({ name, ...header }, completed)
    else pack.entry({ name, ...header }, body, completed)
  })
}

function available(
  bucket: string,
  key: string,
  digest: string,
  size: number,
): ArtifactStorageProjection {
  return {
    status: 'available',
    artifact: {
      kind: 'diagnostic_bundle',
      uri: `s3://${bucket}/${key}`,
      media_type: mediaType,
      digest: `sha256:${digest}`,
      size_bytes: size,
    },
  }
}

function isNotFound(error: unknown): boolean {
  return statusCode(error) === 404
}

function isPreconditionFailed(error: unknown): boolean {
  return statusCode(error) === 412
}

function statusCode(error: unknown): unknown {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    error.$metadata.httpStatusCode
  )
}
