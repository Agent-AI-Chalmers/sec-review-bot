import { expect, test } from 'vitest'

import { parseExecutionArchiveArtifact } from '../src/temporal-execution-client.js'

const artifact = {
  status: 'available',
  artifact: {
    kind: 'execution_archive',
    uri: 's3://sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst',
    media_type: 'application/tar+zstd',
    digest: `sha256:${'a'.repeat(64)}`,
    size_bytes: 42
  }
} as const

test('accepts the workflow-owned execution archive reference', () => {
  expect(parseExecutionArchiveArtifact(artifact, 'run-1')).toStrictEqual(
    artifact
  )
})

test('rejects the deleted standalone trajectory object', () => {
  expect(() =>
    parseExecutionArchiveArtifact(
      {
        ...artifact,
        artifact: {
          ...artifact.artifact,
          uri: 's3://sec-review/runs/run-1/trajectories/review-trajectories.v1.tar.zst'
        }
      },
      'run-1'
    )
  ).toThrow(/invalid execution archive URI/)
})

test('binds the diagnostic reference to the requested run', () => {
  expect(() => parseExecutionArchiveArtifact(artifact, 'run-2')).toThrow(
    /invalid execution archive URI/
  )
})

test('requires a successful diagnostic publication', () => {
  expect(() => parseExecutionArchiveArtifact(undefined, 'run-1')).toThrow(
    /missing artifact_storage/
  )
})

for (const [name, value] of Object.entries({
  'wrong publication status': { ...artifact, status: 'unavailable' },
  'missing artifact': { status: 'available' },
  'wrong artifact kind': {
    ...artifact,
    artifact: { ...artifact.artifact, kind: 'trajectory' }
  },
  'wrong media type': {
    ...artifact,
    artifact: { ...artifact.artifact, media_type: 'application/zstd' }
  },
  'invalid digest': {
    ...artifact,
    artifact: { ...artifact.artifact, digest: 'sha256:invalid' }
  },
  'negative size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: -1 }
  },
  'fractional size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: 1.5 }
  },
  'coerced size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: '42' }
  },
  'unsafe size': {
    ...artifact,
    artifact: { ...artifact.artifact, size_bytes: 2 ** 53 }
  },
  'local file URI': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: 'file:///tmp/execution-archive.v1.tar.zst'
    }
  },
  'URI credentials': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: 's3://user@sec-review/runs/run-1/artifacts/execution-archive.v1.tar.zst'
    }
  },
  'URI port': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: 's3://sec-review:9000/runs/run-1/artifacts/execution-archive.v1.tar.zst'
    }
  },
  'URI query': {
    ...artifact,
    artifact: {
      ...artifact.artifact,
      uri: `${artifact.artifact.uri}?download=1`
    }
  },
  'URI fragment': {
    ...artifact,
    artifact: { ...artifact.artifact, uri: `${artifact.artifact.uri}#archive` }
  }
})) {
  test(`rejects ${name}`, () => {
    expect(() => parseExecutionArchiveArtifact(value, 'run-1')).toThrow()
  })
}
