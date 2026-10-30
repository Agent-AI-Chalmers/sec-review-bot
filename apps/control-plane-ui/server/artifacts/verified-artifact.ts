import crypto from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { ArtifactStore } from './store.js'

/** The identity Review Runs or Memory Catalog published for one stored object. */
export interface AvailableArtifact {
  digest: string
  key: string
  maximumSize: number
  sizeBytes: number
}

export class ArtifactDownloadTimeoutError extends Error {
  constructor() {
    super('Artifact download made no progress before the idle timeout.')
    this.name = 'ArtifactDownloadTimeoutError'
  }
}

interface ReadVerifiedArtifactOptions {
  idleTimeoutMs: number
  signal?: AbortSignal
}

interface VerifiedArtifactFile {
  path: string
  sizeBytes: number
}

/**
 * Stream one artifact through the shared size and digest checks.
 *
 * The idle timeout guards a body that stops making progress; a caller that wants a total
 * deadline can combine this with its own abort signal. Keeping the check in one function means
 * preview, download, and memory artifact reads cannot drift into different identity rules.
 */
async function streamVerifiedArtifact(
  artifactStore: ArtifactStore,
  artifact: AvailableArtifact,
  options: ReadVerifiedArtifactOptions,
  sink: Writable
): Promise<void> {
  const controller = new AbortController()
  let body: Readable | undefined
  let idleTimeout: NodeJS.Timeout | undefined
  let timedOut = false
  const resetIdleTimeout = (): void => {
    clearTimeout(idleTimeout)
    idleTimeout = setTimeout(() => {
      timedOut = true
      controller.abort()
      // Once getObject has returned, aborting its signal may not affect the body stream.
      body?.destroy(new ArtifactDownloadTimeoutError())
    }, options.idleTimeoutMs)
    idleTimeout.unref()
  }
  const abortFromCaller = (): void => {
    controller.abort()
    body?.destroy()
  }
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    resetIdleTimeout()
    if (options.signal?.aborted) controller.abort()
    const object = await artifactStore.getObject(
      artifact.key,
      controller.signal
    )
    body = object.body
    resetIdleTimeout()
    if (
      object.contentLength !== undefined &&
      (object.contentLength !== artifact.sizeBytes ||
        object.contentLength > artifact.maximumSize)
    )
      throw new Error('artifact_identity_mismatch')

    const digest = crypto.createHash('sha256')
    let size = 0
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > artifact.sizeBytes || size > artifact.maximumSize) {
          callback(new Error('artifact_identity_mismatch'))
          return
        }
        digest.update(bytes)
        resetIdleTimeout()
        callback(null, bytes)
      }
    })
    await pipeline(body, verify, sink, { signal: controller.signal })
    clearTimeout(idleTimeout)
    if (
      size !== artifact.sizeBytes ||
      `sha256:${digest.digest('hex')}` !== artifact.digest
    )
      throw new Error('artifact_identity_mismatch')
  } catch (error) {
    if (timedOut) throw new ArtifactDownloadTimeoutError()
    throw error
  } finally {
    clearTimeout(idleTimeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
    if (body !== undefined && !body.destroyed) body.destroy()
  }
}

/** Read a verified artifact into memory for previews and JSON projections. */
export async function readVerifiedArtifactBuffer(
  artifactStore: ArtifactStore,
  artifact: AvailableArtifact,
  options: ReadVerifiedArtifactOptions
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      chunks.push(Buffer.from(chunk))
      callback()
    }
  })
  await streamVerifiedArtifact(artifactStore, artifact, options, sink)
  return Buffer.concat(chunks)
}

/**
 * Write a verified artifact to a temporary file, run the caller's use, then remove it.
 *
 * The callback scopes cleanup so an early return or a failed response stream cannot leave a
 * temporary directory behind.
 */
export async function withVerifiedArtifactFile<T>(
  artifactStore: ArtifactStore,
  artifact: AvailableArtifact,
  options: ReadVerifiedArtifactOptions & { filename: string },
  use: (file: VerifiedArtifactFile) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'sec-review-artifact-'))
  try {
    const file = path.join(directory, options.filename)
    await streamVerifiedArtifact(
      artifactStore,
      artifact,
      options,
      createWriteStream(file)
    )
    return await use({ path: file, sizeBytes: artifact.sizeBytes })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
