import type { AvailableArtifact } from '../artifacts/verified-artifact.js'
import { MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES } from './diagnostic-bundle.js'

export function availableArtifact(
  value: unknown,
  runId: string,
  bucket: string
): AvailableArtifact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const storage = value as Record<string, unknown>
  if (storage.status !== 'available') return null
  if (
    typeof storage.artifact !== 'object' ||
    storage.artifact === null ||
    Array.isArray(storage.artifact)
  )
    return null
  const artifact = storage.artifact as Record<string, unknown>
  const expectedUri = `s3://${bucket}/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
  if (
    artifact.kind !== 'diagnostic_bundle' ||
    artifact.uri !== expectedUri ||
    artifact.media_type !== 'application/tar+zstd' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0
  )
    return null
  const key = expectedUri.slice(`s3://${bucket}/`.length)
  return {
    digest: artifact.digest,
    key,
    maximumSize: MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES,
    sizeBytes: artifact.size_bytes as number
  }
}
