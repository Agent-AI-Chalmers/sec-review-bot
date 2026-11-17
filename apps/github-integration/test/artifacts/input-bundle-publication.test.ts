import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import type { InputBundleCandidate } from '../../src/review-runs/review-runs-api.js'
import type { InputBundlePublicationStore } from '../../src/artifacts/input-bundle-publication.js'
import type { PublishContext } from '../../src/review-runs/publish-context.js'

process.env.SEC_REVIEW_ARTIFACT_STORE = 's3'
process.env.SEC_REVIEW_ARTIFACT_S3_BUCKET = 'sec-review'
const { publishAndSubmitInputBundle, recoverInputBundlePublication } =
  await import('../../src/artifacts/input-bundle-publication.js')
const s3 = mockClient(S3Client)
const context: PublishContext = {
  issue: {
    owner_login: 'octo',
    repo_name: 'repo',
    repo_full_name: 'octo/repo',
    default_branch: 'main',
    issue_number: 1,
    issue_title: 'test'
  },
  workspace_ref: 'head',
  event_type: 'opened',
  open_pr: false
}

for (const crash of [
  'before-upload',
  'upload-response',
  'after-upload',
  'after-confirm',
  'before-commit',
  'after-commit'
] as const) {
  test(`recovers the original input after ${crash} failure`, async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'publication-crash-')
    )
    const source = path.join(directory, 'bundle')
    const bytes = Buffer.from('immutable bundle')
    await fs.writeFile(source, bytes)
    const reference = {
      uri: pathToFileURL(source).href,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      media_type: 'application/tar+zstd' as const,
      size_bytes: bytes.length
    }
    let candidate: InputBundleCandidate | undefined
    let uploaded = false
    let authoritative: unknown
    let crashed = false
    const failOnce = () => {
      if (!crashed) {
        crashed = true
        throw new Error('process died')
      }
    }
    s3.reset()
    s3.on(ListObjectsV2Command).resolves({ Contents: [] })
    s3.on(HeadObjectCommand).callsFake(() => {
      if (!uploaded)
        throw Object.assign(new Error('missing'), {
          $metadata: { httpStatusCode: 404 }
        })
      return {
        ContentLength: bytes.length,
        Metadata: {
          sha256: reference.digest.slice(7),
          'media-type': reference.media_type
        }
      }
    })
    s3.on(PutObjectCommand).callsFake(() => {
      uploaded = true
      if (crash === 'upload-response') failOnce()
      return {}
    })
    const store: InputBundlePublicationStore = {
      async reserveInputBundleCandidate(runId, _token, intent) {
        candidate = {
          run_id: runId,
          digest: intent.reference.digest,
          ...structuredClone(intent),
          status: 'reserved'
        }
        if (crash === 'before-upload') failOnce()
        return candidate
      },
      async listInputBundleCandidates() {
        return candidate && candidate.status !== 'abandoned'
          ? [structuredClone(candidate)]
          : []
      },
      async settleInputBundleCandidate(_run, _token, _digest, status) {
        expect.assert(candidate)
        if (crash === 'after-upload') failOnce()
        candidate.status = status
        if (crash === 'after-confirm') failOnce()
        return candidate
      },
      async submitPreparedRun(_run, _token, savedContext, input) {
        if (crash === 'before-commit') failOnce()
        expect.assert(candidate)
        candidate.status = 'selected'
        authoritative = structuredClone({ context: savedContext, input })
        if (crash === 'after-commit') failOnce()
      }
    }
    try {
      await expect(
        publishAndSubmitInputBundle(store, 'run', 'original', context, {
          input_bundle: reference,
          subject: 'original snapshot'
        })
      ).rejects.toThrow(/process died/)
      expect.assert(
        candidate,
        'intent must be durable before the first external write'
      )
      if (crash === 'before-upload') {
        expect(
          await recoverInputBundlePublication(store, 'run', 'takeover')
        ).toBe(false)
        expect(candidate.status).toBe('abandoned')
        expect(authoritative).toBe(undefined)
      } else {
        expect(
          await recoverInputBundlePublication(store, 'run', 'takeover')
        ).toBe(true)
        expect(authoritative).toStrictEqual({
          context,
          input: {
            input_bundle: candidate.reference,
            subject: 'original snapshot'
          }
        })
        expect(candidate.status).toBe('selected')
        expect(
          s3.commandCalls(PutObjectCommand).length,
          'recovery must not rebuild or upload again'
        ).toBe(1)
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}

test('an unavailable store is not evidence that the intent should be abandoned', async () => {
  s3.reset()
  s3.on(HeadObjectCommand).rejects(new Error('storage unavailable'))
  const digest = `sha256:${'a'.repeat(64)}`
  const candidate: InputBundleCandidate = {
    run_id: 'run',
    digest,
    reference: {
      uri: `s3://sec-review/runs/run/input/${digest.slice(7)}/input-bundle.v1.tar.zst`,
      digest,
      media_type: 'application/tar+zstd',
      size_bytes: 1
    },
    input: {},
    publish_context: {},
    status: 'reserved'
  }
  const store: InputBundlePublicationStore = {
    async listInputBundleCandidates() {
      return [candidate]
    },
    async reserveInputBundleCandidate() {
      expect.unreachable('must not rebuild')
    },
    async settleInputBundleCandidate() {
      expect.unreachable('must not abandon on an uncertain read')
    },
    async submitPreparedRun() {
      expect.unreachable('must not submit unverified bytes')
    }
  }
  await expect(
    recoverInputBundlePublication(store, 'run', 'current')
  ).rejects.toThrow(/storage unavailable/)
})
