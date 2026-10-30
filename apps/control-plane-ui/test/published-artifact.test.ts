import assert from 'node:assert/strict'
import test from 'node:test'

import { publishedArtifact } from '../server/artifacts/published-artifact.js'
import { ARTIFACT_BUCKET } from '../server/artifacts/store.js'
import { catalogArtifactReference } from '../server/memory/artifact-reference.js'
import { memoryTreeObjectKey } from '../server/memory/memory-tree-artifact.js'
import { runDiagnosticBundle } from '../server/run/artifact-reference.js'

const BUCKET = ARTIFACT_BUCKET
const DIGEST = `sha256:${'a'.repeat(64)}`

function runBody(artifact: Record<string, unknown>): {
  run_id: string
  artifact_storage: unknown
} {
  return {
    run_id: 'run-1',
    artifact_storage: { status: 'available', artifact }
  }
}

const bundleArtifact = {
  kind: 'diagnostic_bundle',
  uri: `s3://${BUCKET}/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst`,
  digest: DIGEST,
  media_type: 'application/tar+zstd',
  size_bytes: 1024
}

/**
 * A published record is untrusted input, so every field that decides which bytes get
 * served is checked by the same module. These assert the rules that must not drift between
 * the run and memory artifact kinds.
 */
test('a run diagnostic bundle resolves to the object it names', () => {
  const published = runDiagnosticBundle(
    runBody(bundleArtifact),
    'run-1',
    BUCKET
  )
  assert.strictEqual(published.kind, 'available')
  assert.deepStrictEqual(
    published.kind === 'available' ? published.artifact : null,
    {
      digest: DIGEST,
      key: 'runs/run-1/artifacts/diagnostic-tree.v1.tar.zst',
      maximumSize: 128 * 1024 * 1024,
      sizeBytes: 1024
    }
  )
})

test('a run body for another run never resolves an artifact', () => {
  assert.deepStrictEqual(
    runDiagnosticBundle(runBody(bundleArtifact), 'run-2', BUCKET),
    { kind: 'invalid' }
  )
})

test('a run that has not published an artifact resolves nothing', () => {
  assert.deepStrictEqual(
    runDiagnosticBundle(
      { run_id: 'run-1', artifact_storage: { status: 'pending' } },
      'run-1',
      BUCKET
    ),
    { kind: 'invalid' }
  )
})

test('a reference naming a different object is invalid', () => {
  const elsewhere = {
    ...bundleArtifact,
    uri: `s3://${BUCKET}/runs/run-1/artifacts/other.v1.tar.zst`
  }
  assert.deepStrictEqual(
    runDiagnosticBundle(runBody(elsewhere), 'run-1', BUCKET),
    { kind: 'invalid' }
  )
  const wrongBucket = {
    ...bundleArtifact,
    uri: 's3://other-bucket/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst'
  }
  assert.deepStrictEqual(
    runDiagnosticBundle(runBody(wrongBucket), 'run-1', BUCKET),
    { kind: 'invalid' }
  )
})

test('malformed fields are invalid rather than unavailable', () => {
  for (const broken of [
    { ...bundleArtifact, digest: 'sha256:xyz' },
    { ...bundleArtifact, digest: `sha256:${'A'.repeat(64)}` },
    { ...bundleArtifact, media_type: 'application/zstd' },
    { ...bundleArtifact, size_bytes: -1 },
    { ...bundleArtifact, size_bytes: 1.5 },
    { ...bundleArtifact, uri: 42 }
  ])
    assert.deepStrictEqual(
      runDiagnosticBundle(runBody(broken), 'run-1', BUCKET),
      { kind: 'invalid' },
      JSON.stringify(broken)
    )
})

test('an object over the serving budget is reported as too large', () => {
  const oversized = { ...bundleArtifact, size_bytes: 128 * 1024 * 1024 + 1 }
  assert.deepStrictEqual(
    runDiagnosticBundle(runBody(oversized), 'run-1', BUCKET),
    { kind: 'too_large' }
  )
})

test('a memory tree must name the key its digest derives', () => {
  const artifact = {
    uri: `s3://${BUCKET}/${memoryTreeObjectKey(DIGEST)}`,
    digest: DIGEST,
    media_type: 'application/tar+zstd',
    size_bytes: 2048
  }
  const published = catalogArtifactReference(artifact, 'tree')
  assert.strictEqual(published.kind, 'available')
  assert.strictEqual(
    published.kind === 'available' ? published.artifact.key : '',
    memoryTreeObjectKey(DIGEST)
  )
  assert.deepStrictEqual(
    catalogArtifactReference(
      { ...artifact, uri: `s3://${BUCKET}/memory/trees/other/file.tar.zst` },
      'tree'
    ),
    { kind: 'invalid' }
  )
})

test('a trajectory reference stays inside its published prefix', () => {
  const artifact = {
    uri: `s3://${BUCKET}/memory/trajectories/run-1.jsonl.zst`,
    digest: DIGEST,
    media_type: 'application/zstd',
    size_bytes: 64
  }
  assert.strictEqual(
    catalogArtifactReference(artifact, 'trajectory').kind,
    'available'
  )
  assert.deepStrictEqual(
    catalogArtifactReference(
      {
        ...artifact,
        uri: `s3://${BUCKET}/memory/trees/run-1.jsonl.zst`
      },
      'trajectory'
    ),
    { kind: 'invalid' }
  )
})

test('a non-object reference is invalid', () => {
  for (const value of [null, undefined, 'artifact', 7, []])
    assert.deepStrictEqual(
      publishedArtifact(value, {
        bucket: BUCKET,
        mediaType: 'application/zstd',
        maximumSize: 1,
        acceptsKey: () => true
      }),
      { kind: 'invalid' }
    )
})
