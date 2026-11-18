import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, afterAll, test } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { InputBundleCandidate } from '../../src/review-runs/review-runs-api.js'
import type { InputBundlePublicationStore } from '../../src/artifacts/input-bundle-publication.js'
import type { PublishContext } from '../../src/review-runs/publish-context.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-input-publication-'))
process.env.SEC_REVIEW_ARTIFACT_STORE = 'file'
process.env.SEC_REVIEW_INPUT_BUNDLE_ROOT = root
afterAll(() => fs.rm(root, { recursive: true, force: true }))
const { publishedInputBundleReference, publishInputBundle, inputBundleExists } =
  await import('../../src/artifacts/input-storage.js')
const { publishAndSubmitInputBundle, recoverInputBundlePublication } =
  await import('../../src/artifacts/input-bundle-publication.js')

async function bundle(content = 'same immutable archive') {
  const attempt = await fs.mkdtemp(path.join(root, 'attempt-'))
  const source = path.join(attempt, 'bundle.tar.zst')
  await fs.writeFile(source, content)
  return {
    uri: pathToFileURL(source).href,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    media_type: 'application/tar+zstd' as const,
    size_bytes: Buffer.byteLength(content)
  }
}

test('identical bundles from different attempts publish one independent file', async () => {
  const first = await bundle()
  const second = await bundle()
  const run = randomUUID()
  expect(publishedInputBundleReference(first, run)).toStrictEqual(
    publishedInputBundleReference(second, run)
  )
  const [left, right] = await Promise.all([
    publishInputBundle(first, run),
    publishInputBundle(second, run)
  ])
  expect(left).toStrictEqual(right)
  await fs.rm(fileURLToPath(first.uri))
  await fs.writeFile(fileURLToPath(second.uri), 'changed staging file')
  expect(await inputBundleExists(left)).toBe(true)
  expect(await fs.readFile(new URL(left.uri), 'utf8')).toBe('same immutable archive')
  expect(await fs.readdir(path.dirname(fileURLToPath(left.uri)))).toStrictEqual([
    'input-bundle.v1.tar.zst'
  ])
})

test('an incomplete or invalid staging copy never occupies the final path', async () => {
  const source = await bundle()
  const run = randomUUID()
  const published = publishedInputBundleReference(source, run)
  await fs.writeFile(new URL(source.uri), 'corrupt')
  await expect(publishInputBundle(source, run)).rejects.toThrow(/differs/)
  expect(await inputBundleExists(published)).toBe(false)
  expect(await fs.readdir(path.dirname(fileURLToPath(published.uri)))).toStrictEqual([])
  const rebuilt = await bundle()
  expect(await publishInputBundle(rebuilt, run)).toStrictEqual(published)
})

test('conflicting bytes at the final path are rejected without overwrite', async () => {
  const source = await bundle()
  const run = randomUUID()
  const destination = fileURLToPath(publishedInputBundleReference(source, run).uri)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, 'conflicting bytes')
  await expect(publishInputBundle(source, run)).rejects.toThrow(/differs/)
  expect(await fs.readFile(destination, 'utf8')).toBe('conflicting bytes')
})

for (const crash of ['reserved', 'published', 'confirmed', 'committed'] as const) {
  test(`file publication recovers after ${crash} and staging loss`, async () => {
    const run = randomUUID()
    const source = await bundle()
    const context = {} as PublishContext
    let candidate: InputBundleCandidate | undefined
    let stopped = false
    const crashOnce = (step: typeof crash) => {
      if (step === crash && !stopped) {
        stopped = true
        throw new Error('worker stopped')
      }
    }
    const store: InputBundlePublicationStore = {
      async reserveInputBundleCandidate(runId, _token, intent) {
        if (candidate)
          expect(intent).toStrictEqual({
            reference: candidate.reference,
            input: candidate.input,
            publish_context: candidate.publish_context
          })
        candidate = {
          run_id: runId,
          digest: intent.reference.digest,
          ...structuredClone(intent),
          status: 'reserved'
        }
        crashOnce('reserved')
        return candidate
      },
      async listInputBundleCandidates() {
        return candidate && candidate.status !== 'abandoned' ? [candidate] : []
      },
      async settleInputBundleCandidate(_run, _token, _digest, status) {
        expect.assert(candidate)
        if (status === 'present') crashOnce('published')
        candidate.status = status
        if (status === 'present') crashOnce('confirmed')
        return candidate
      },
      async submitPreparedRun(_run, _token, savedContext, input) {
        expect.assert(candidate)
        expect(savedContext).toStrictEqual(candidate.publish_context)
        expect(input).toStrictEqual(candidate.input)
        candidate.status = 'selected'
        crashOnce('committed')
      }
    }
    await expect(
      publishAndSubmitInputBundle(store, run, 'first', context, {
        input_bundle: source
      })
    ).rejects.toThrow(/worker stopped/)
    await fs.rm(fileURLToPath(source.uri))
    const recovered = await recoverInputBundlePublication(store, run, 'takeover')
    if (crash === 'reserved') {
      expect(recovered).toBe(false)
      expect(candidate?.status).toBe('abandoned')
      const rebuilt = await bundle()
      expect(rebuilt.uri).not.toBe(source.uri)
      await publishAndSubmitInputBundle(store, run, 'takeover', context, {
        input_bundle: rebuilt
      })
    } else expect(recovered).toBe(true)
    expect(candidate?.status).toBe('selected')
    expect(await inputBundleExists(candidate!.reference)).toBe(true)
  })
}
