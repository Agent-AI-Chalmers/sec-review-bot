import type { PublishedArtifact } from '../artifacts/published-artifact.js'
import { publishedArtifact } from '../artifacts/published-artifact.js'
import { ARTIFACT_BUCKET } from '../artifacts/store.js'
import {
  MAX_MEMORY_TREE_ARTIFACT_BYTES,
  MEMORY_TREE_MEDIA_TYPE,
  memoryTreeObjectKey
} from './memory-tree-artifact.js'
import { MAX_TRAJECTORY_ARTIFACT_BYTES } from './trajectory-artifact.js'

const TRAJECTORY_MEDIA_TYPE = 'application/zstd'
const TRAJECTORY_KEY_PREFIX = 'memory/trajectories/'

/**
 * One artifact reference a Memory Catalog record published.
 *
 * A memory tree names the object it published exactly — its key is derived from the digest
 * — so the record cannot point at a second tree with the same digest. A trajectory is
 * published per writer run, so only its prefix is fixed here.
 */
export function catalogArtifactReference(
  value: unknown,
  kind: 'tree' | 'trajectory'
): PublishedArtifact {
  if (kind === 'tree')
    return publishedArtifact(value, {
      bucket: ARTIFACT_BUCKET,
      mediaType: MEMORY_TREE_MEDIA_TYPE,
      maximumSize: MAX_MEMORY_TREE_ARTIFACT_BYTES,
      acceptsKey: (key, digest) => key === memoryTreeObjectKey(digest)
    })
  return publishedArtifact(value, {
    bucket: ARTIFACT_BUCKET,
    mediaType: TRAJECTORY_MEDIA_TYPE,
    maximumSize: MAX_TRAJECTORY_ARTIFACT_BYTES,
    acceptsKey: (key) => key.startsWith(TRAJECTORY_KEY_PREFIX)
  })
}
