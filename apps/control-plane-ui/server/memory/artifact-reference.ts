import { ARTIFACT_BUCKET } from '../artifacts/store.js'
import type { AvailableArtifact } from '../artifacts/verified-artifact.js'
import {
  MAX_MEMORY_TREE_ARTIFACT_BYTES,
  memoryTreeObjectKey
} from './memory-tree-artifact.js'
import { MAX_TRAJECTORY_ARTIFACT_BYTES } from './trajectory-artifact.js'

export function catalogArtifactReference(
  value: unknown,
  kind: 'tree' | 'trajectory'
): AvailableArtifact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const artifact = value as Record<string, unknown>
  if (
    typeof artifact.uri !== 'string' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0 ||
    (kind === 'tree'
      ? artifact.media_type !== 'application/tar+zstd'
      : artifact.media_type !== 'application/zstd')
  )
    return null
  const maximumSize =
    kind === 'tree'
      ? MAX_MEMORY_TREE_ARTIFACT_BYTES
      : MAX_TRAJECTORY_ARTIFACT_BYTES
  if ((artifact.size_bytes as number) > maximumSize) return null
  const prefix = `s3://${ARTIFACT_BUCKET}/memory/${kind === 'tree' ? 'trees/' : 'trajectories/'}`
  if (!artifact.uri.startsWith(prefix)) return null
  if (
    kind === 'tree' &&
    artifact.uri !==
      `s3://${ARTIFACT_BUCKET}/${memoryTreeObjectKey(artifact.digest)}`
  )
    return null
  return {
    digest: artifact.digest,
    key: artifact.uri.slice(`s3://${ARTIFACT_BUCKET}/`.length),
    maximumSize,
    sizeBytes: artifact.size_bytes as number
  }
}
