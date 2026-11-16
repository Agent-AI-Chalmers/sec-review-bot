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

for (const [name, value] of Object.entries({
  'wrong publication status': { ...artifact, status: 'unavailable' },
  'missing artifact': { status: 'available' },
  'wrong artifact kind': {
    ...artifact,
    artifact: { ...artifact.artifact, kind: 'trajectory' },
  },
  'wrong media type': {
    ...artifact,
    artifact: { ...artifact.artifact, media_type: 'application/zstd' },
  },
  'invalid digest': {
    ...artifact,
    artifact: { ...artifact.artifact, digest: 'sha256:invalid' },
  },
  'negative size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: -1 },
  },
  'fractional size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: 1.5 },
  },
  'coerced size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: '42' },
  },
  'unsafe size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: 2 ** 53 },
  },
  'local file URI': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: 'file:///tmp/execution-archive.v1.tar.zst',
    },
  },
  'URI credentials': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: 's3://user@sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    },
  },
  'URI port': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: 's3://sec-review:9000/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    },
  },
  'URI query': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: `${artifact.artifact.uri}?download=1`,
    },
  },
  'URI fragment': {
    ...artifact,
    artifact: { ...artifact.artifact, uri: `${artifact.artifact.uri}#archive` },
  },
})) {
  await test(`rejects ${name}`, () => {
    assert.throws(() => parseExecutionArchiveArtifact(value, 'run-1'))
  })
}
