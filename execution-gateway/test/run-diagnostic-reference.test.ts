import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRunDiagnosticArtifact } from '../src/temporal-execution-store.js'

const artifact = {
  status: 'available',
  artifact: {
    kind: 'diagnostic_bundle',
    uri: 's3://sec-review/runs/run-1/artifacts/diagnostic-tree.v1.tar.zst',
    media_type: 'application/tar+zstd',
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42,
  },
} as const

await test('accepts the workflow-owned run diagnostic reference', () => {
  assert.deepEqual(parseRunDiagnosticArtifact(artifact, 'run-1'), artifact)
})

await test('rejects the deleted standalone transcript object', () => {
  assert.throws(
    () =>
      parseRunDiagnosticArtifact(
        {
          ...artifact,
          artifact: {
            ...artifact.artifact,
            uri: 's3://sec-review/runs/run-1/transcripts/review-transcripts.v1.tar.zst',
          },
        },
        'run-1',
      ),
    /invalid diagnostic artifact URI/,
  )
})

await test('binds the diagnostic reference to the requested run', () => {
  assert.throws(
    () => parseRunDiagnosticArtifact(artifact, 'run-2'),
    /invalid diagnostic artifact URI/,
  )
})

await test('requires a successful diagnostic publication', () => {
  assert.throws(
    () => parseRunDiagnosticArtifact(undefined, 'run-1'),
    /missing artifact_storage/,
  )
})
