import type { AvailableArtifact } from './verified-artifact.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/

/** What one caller is willing to serve, and which object that caller asked for. */
export interface ArtifactExpectation {
  bucket: string
  mediaType: string
  /** The largest object this caller will serve, in bytes. */
  maximumSize: number
  /** Whether this store key names the object the caller asked for. */
  acceptsKey(key: string, digest: string): boolean
}

export type PublishedArtifact =
  | { kind: 'available'; artifact: AvailableArtifact }
  | { kind: 'too_large' }
  | { kind: 'invalid' }

/**
 * Validate one published artifact reference into the identity the store can verify.
 *
 * Review Runs and Memory Catalog publish their own fields, but a record that reaches the
 * BFF is still untrusted input. The digest shape, the exact object key, the media type and
 * the size budget are the same rules for every artifact kind, so they are checked once
 * here; a caller supplies only what differs. A record naming another object is invalid
 * rather than merely unusual, because reading it would serve bytes nobody published for
 * this request.
 */
export function publishedArtifact(
  value: unknown,
  expected: ArtifactExpectation
): PublishedArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { kind: 'invalid' }
  const record = value as Record<string, unknown>
  const digest = record.digest
  const uri = record.uri
  const sizeBytes = record.size_bytes
  if (typeof digest !== 'string' || !DIGEST.test(digest))
    return { kind: 'invalid' }
  if (typeof uri !== 'string') return { kind: 'invalid' }
  if (record.media_type !== expected.mediaType) return { kind: 'invalid' }
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0
  )
    return { kind: 'invalid' }
  const prefix = `s3://${expected.bucket}/`
  if (!uri.startsWith(prefix)) return { kind: 'invalid' }
  const key = uri.slice(prefix.length)
  if (!expected.acceptsKey(key, digest)) return { kind: 'invalid' }
  if (sizeBytes > expected.maximumSize) return { kind: 'too_large' }
  return {
    kind: 'available',
    artifact: {
      digest,
      key,
      maximumSize: expected.maximumSize,
      sizeBytes
    }
  }
}
