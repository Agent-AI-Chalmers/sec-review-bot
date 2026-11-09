import assert from 'node:assert/strict'
import test from 'node:test'

import { parseExecutionArchiveArtifact } from '../src/temporal-execution-client.js'

const artifact = {
  status: 'available',
  artifact: {
    kind: 'execution_archive',
    uri: 's3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    media_type: 'application/tar+zstd',
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42,
  },
} as const

await test('accepts the workflow-owned execution archive reference', () => {
  assert.deepEqual(parseExecutionArchiveArtifact(artifact, 'run-1'), artifact)
})

await test('rejects the deleted standalone trajectory object', () => {
  assert.throws(
    () =>
      parseExecutionArchiveArtifact(
        {
          ...artifact,
          artifact: {
            ...artifact.artifact,
            uri: 's3://sec-review/runs/run-1/trajectories/review-trajectories.v1.tar.zst',
          },
        },
        'run-1',
      ),
    /invalid execution archive URI/,
  )
})

await test('binds the diagnostic reference to the requested run', () => {
  assert.throws(
    () => parseExecutionArchiveArtifact(artifact, 'run-2'),
    /invalid execution archive URI/,
  )
})

await test('requires a successful diagnostic publication', () => {
  assert.throws(
    () => parseExecutionArchiveArtifact(undefined, 'run-1'),
    /missing artifact_storage/,
  )
})
