import type { PublishedArtifact } from '../artifacts/published-artifact.js'
import { publishedArtifact } from '../artifacts/published-artifact.js'
import { MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES } from './diagnostic-bundle.js'

const DIAGNOSTIC_BUNDLE = 'diagnostic-tree.v1.tar.zst'
const DIAGNOSTIC_BUNDLE_MEDIA_TYPE = 'application/tar+zstd'

/** The part of a Review Runs run body that says which artifact the run published. */
export interface PublishedRunArtifact {
  run_id?: unknown
  artifact_storage?: unknown
}

/**
 * The diagnostic bundle one run published, if this body is the run that was asked for.
 *
 * The identity check belongs here rather than at each caller: a body for another run must
 * not resolve to an artifact this request would then serve under the wrong run id.
 */
export function runDiagnosticBundle(
  run: PublishedRunArtifact | undefined,
  runId: string,
  bucket: string
): PublishedArtifact {
  if (run?.run_id !== runId) return { kind: 'invalid' }
  const storage = run.artifact_storage as
    { status?: unknown; artifact?: unknown } | undefined
  if (storage?.status !== 'available') return { kind: 'invalid' }
  return publishedArtifact(storage.artifact, {
    bucket,
    mediaType: DIAGNOSTIC_BUNDLE_MEDIA_TYPE,
    maximumSize: MAX_DIAGNOSTIC_BUNDLE_VIEW_BYTES,
    acceptsKey: (key) => key === `runs/${runId}/artifacts/${DIAGNOSTIC_BUNDLE}`
  })
}
