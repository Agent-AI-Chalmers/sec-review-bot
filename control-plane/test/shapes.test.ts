import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeArtifactStorage } from '../src/shapes.js'

test('an available artifact storage record keeps its artifact reference', () => {
  const artifact = {
    kind: 'diagnostic_bundle' as const,
    uri: 's3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst',
    media_type: 'application/tar+zstd' as const,
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42
  }

  assert.deepEqual(normalizeArtifactStorage({ status: 'available', artifact }), {
    status: 'available',
    artifact
  })
})

test('normalizeArtifactStorage rejects an available record with no artifact', () => {
  // The runner's own schema requires only `status` and allows a null `artifact`, because it
  // also covers the unavailable/failed cases. The persisted record's schema is stricter: an
  // `available` branch without `artifact` is invalid, and the repository ships a fixture
  // asserting exactly that. `parseArtifactStorage` is what rejects such a payload at the
  // runner boundary; this asserts the narrowing does not silently accept one if a future
  // caller skips that boundary and persists a record the contract forbids.
  for (const storage of [
    { status: 'available' as const },
    { status: 'available' as const, artifact: null }
  ]) {
    assert.throws(
      () => normalizeArtifactStorage(storage),
      /must carry its artifact reference/,
      `${JSON.stringify(storage)} must be rejected`
    )
  }
})

test('unavailable and failed records carry their reason without an artifact', () => {
  assert.deepEqual(normalizeArtifactStorage({ status: 'unavailable' }), { status: 'unavailable' })
  assert.deepEqual(
    normalizeArtifactStorage({
      status: 'failed',
      error_code: 'ARTIFACT_UPLOAD_FAILED',
      message: 'Unable to store terminal run artifacts.'
    }),
    {
      status: 'failed',
      error_code: 'ARTIFACT_UPLOAD_FAILED',
      message: 'Unable to store terminal run artifacts.'
    }
  )
  // Null storage (the runner never attached metadata) stays null rather than becoming absent.
  assert.equal(normalizeArtifactStorage(null), null)
})
