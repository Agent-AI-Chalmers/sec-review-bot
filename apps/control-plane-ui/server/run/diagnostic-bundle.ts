import { TextDecoder } from 'node:util'
import tar from 'tar-stream'

import { decompressRestrictedPaxArchive } from '../artifacts/tar-zstd.js'

export const MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 100_000
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
const MAX_PREVIEW_FILE_BYTES = 8 * 1024 * 1024
const MAX_PREVIEW_TEXT_BYTES = 64 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })

export interface DiagnosticBundleView {
  files: Record<string, string>
  unpreviewableFiles: Record<string, { sizeBytes: number }>
}

function safePath(name: string): boolean {
  return (
    name !== '' &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    name
      .replace(/\/$/, '')
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

async function collectEntry(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > expectedSize) throw new Error('invalid_diagnostic_bundle')
    chunks.push(bytes)
  }
  if (size !== expectedSize) throw new Error('invalid_diagnostic_bundle')
  return Buffer.concat(chunks)
}

/**
 * Read the diagnostic bundle contract for the run-files UI. This is intentionally independent
 * from the memory archive reader: the two archives have different roots, manifests and limits.
 * Trajectory JSONL remains ordinary source text here; trajectory semantics belong to its viewer.
 */
export async function readDiagnosticBundle(
  bytes: Buffer,
  expectedRunId: string
): Promise<DiagnosticBundleView> {
  if (bytes.length > MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES)
    throw new Error('diagnostic_bundle_too_large')
  let tarBytes: Buffer
  try {
    tarBytes = decompressRestrictedPaxArchive(
      bytes,
      MAX_EXTRACTED_BYTES + MAX_ENTRIES * 2048
    )
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_tar_zstd_envelope')
      throw new Error('invalid_diagnostic_bundle', { cause: error })
    throw error
  }
  const extract = tar.extract()
  const entries = new Map<string, Buffer>()
  const seenPaths = new Set<string>()
  let entryCount = 0
  let extractedBytes = 0

  const completed = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      void (async (): Promise<void> => {
        entryCount += 1
        if (entryCount > MAX_ENTRIES || !safePath(header.name))
          throw new Error('invalid_diagnostic_bundle')
        if (header.type !== 'file' && header.type !== 'directory')
          throw new Error('invalid_diagnostic_bundle')
        const name = header.name.replace(/\/$/, '')
        if (seenPaths.has(name)) throw new Error('invalid_diagnostic_bundle')
        seenPaths.add(name)
        if (header.type === 'directory') {
          stream.resume()
          await new Promise<void>((done, failed) => {
            stream.once('end', done)
            stream.once('error', failed)
          })
        } else {
          extractedBytes += header.size
          if (extractedBytes > MAX_EXTRACTED_BYTES)
            throw new Error('diagnostic_bundle_too_large')
          entries.set(
            name,
            await collectEntry(
              stream as unknown as AsyncIterable<Uint8Array>,
              header.size
            )
          )
        }
        next()
      })().catch(reject)
    })
    extract.once('finish', resolve)
    extract.once('error', reject)
  })
  extract.end(tarBytes)
  await completed

  const manifestBytes = entries.get('manifest.json')
  const resultBytes = entries.get('result.json')
  if (
    !manifestBytes ||
    !resultBytes ||
    ![...entries.keys()].some((name) => name.startsWith('artifact-tree/'))
  )
    throw new Error('invalid_diagnostic_bundle')
  let manifestText: string
  let resultText: string
  try {
    manifestText = utf8.decode(manifestBytes)
    resultText = utf8.decode(resultBytes)
    JSON.parse(resultText)
  } catch {
    throw new Error('invalid_diagnostic_bundle')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new Error('invalid_diagnostic_bundle')
  }
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest)
  )
    throw new Error('invalid_diagnostic_bundle')
  const record = manifest as Record<string, unknown>
  if (
    record.version !== 1 ||
    record.run_id !== expectedRunId ||
    record.result !== 'result.json' ||
    !Array.isArray(record.review_units)
  )
    throw new Error('invalid_diagnostic_bundle')
  const unitIds = new Set<string>()
  for (const unit of record.review_units) {
    if (typeof unit !== 'object' || unit === null || Array.isArray(unit))
      throw new Error('invalid_diagnostic_bundle')
    const reviewUnit = unit as Record<string, unknown>
    if (
      typeof reviewUnit.id !== 'string' ||
      reviewUnit.id === '' ||
      unitIds.has(reviewUnit.id) ||
      !Array.isArray(reviewUnit.trajectories) ||
      reviewUnit.trajectories.length === 0
    )
      throw new Error('invalid_diagnostic_bundle')
    unitIds.add(reviewUnit.id)
    for (const trajectory of reviewUnit.trajectories) {
      if (
        typeof trajectory !== 'string' ||
        !safePath(trajectory) ||
        !trajectory.startsWith('artifact-tree/') ||
        !trajectory.endsWith('.jsonl') ||
        !entries.has(trajectory)
      )
        throw new Error('invalid_diagnostic_bundle')
    }
  }

  const files: Record<string, string> = {}
  const unpreviewableFiles: Record<string, { sizeBytes: number }> = {}
  let previewBytes = 0
  for (const [name, value] of entries) {
    if (value.length > MAX_PREVIEW_FILE_BYTES) {
      unpreviewableFiles[name] = { sizeBytes: value.length }
      continue
    }
    try {
      const text = utf8.decode(value)
      if (
        text.includes('\0') ||
        previewBytes + value.length > MAX_PREVIEW_TEXT_BYTES
      ) {
        unpreviewableFiles[name] = { sizeBytes: value.length }
      } else {
        files[name] = text
        previewBytes += value.length
      }
    } catch {
      unpreviewableFiles[name] = { sizeBytes: value.length }
    }
  }
  return { files, unpreviewableFiles }
}
