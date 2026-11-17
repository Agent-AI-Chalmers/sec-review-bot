import { expect, test } from 'vitest'

import { normalizeArtifactStorage } from '../src/shapes.js'

test('an available artifact storage record keeps its artifact reference', () => {
  const artifact = {
    kind: 'execution_archive' as const,
    uri: 's3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    media_type: 'application/tar+zstd' as const,
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42
  }

  expect(
    normalizeArtifactStorage({ status: 'available', artifact })
  ).toStrictEqual({
    status: 'available',
    artifact
  })
})

test('normalizeArtifactStorage rejects an available record with no artifact', () => {
  // The Execution API schema requires only `status` and allows a null `artifact`, because it
  // also covers the unavailable/failed cases. The persisted record's schema is stricter: an
  // `available` branch without `artifact` is invalid, and the repository ships a fixture
  // asserting exactly that. `parseArtifactStorage` is what rejects such a payload at the
  // execution boundary; this asserts the narrowing does not silently accept one if a future
  // caller skips that boundary and persists a record the contract forbids.
  for (const storage of [
    { status: 'available' as const },
    { status: 'available' as const, artifact: null }
  ]) {
    expect(
      () => normalizeArtifactStorage(storage, 'run r-1'),
      `${JSON.stringify(storage)} must be rejected`
    ).toThrow(
      /run r-1 is an available artifact storage record without its artifact reference/
    )
  }
})

test('the normalization context names the offending record', () => {
  // The message has to identify *which* record is corrupt, or the resulting 500 is
  // undiagnosable. `rowToRecord` passes the run id, so assert the label shows up.
  expect(() =>
    normalizeArtifactStorage({ status: 'available' }, 'run 8c1f')
  ).toThrow(/run 8c1f/)
  expect(
    () => normalizeArtifactStorage({ status: 'available' }),
    'the default context is still a usable label'
  ).toThrow(/artifact_storage/)
})

test('unavailable and failed records carry their reason without an artifact', () => {
  expect(normalizeArtifactStorage({ status: 'unavailable' })).toStrictEqual({
    status: 'unavailable'
  })
  expect(
    normalizeArtifactStorage({
      status: 'failed',
      error_code: 'ARTIFACT_UPLOAD_FAILED',
      message: 'Unable to store terminal run artifacts.'
    })
  ).toStrictEqual({
    status: 'failed',
    error_code: 'ARTIFACT_UPLOAD_FAILED',
    message: 'Unable to store terminal run artifacts.'
  })
  // Null storage (Execution never attached metadata) stays null rather than becoming absent.
  expect(normalizeArtifactStorage(null)).toBe(null)
})
