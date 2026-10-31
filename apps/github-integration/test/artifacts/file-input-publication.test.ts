import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { InputBundleCandidate } from '../../src/review-runs/review-runs-api.js'
import type { InputBundlePublicationStore } from '../../src/artifacts/input-bundle-publication.js'
import type { PublishContext } from '../../src/review-runs/publish-context.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-input-publication-'))
process.env.SEC_REVIEW_ARTIFACT_STORE = 'file'
process.env.SEC_REVIEW_INPUT_BUNDLE_ROOT = root
test.after(() => fs.rm(root, { recursive: true, force: true }))
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
  assert.deepEqual(
    publishedInputBundleReference(first, run),
    publishedInputBundleReference(second, run)
  )
  const [left, right] = await Promise.all([
    publishInputBundle(first, run),
    publishInputBundle(second, run)
  ])
  assert.deepEqual(left, right)
  await fs.rm(fileURLToPath(first.uri))
  await fs.writeFile(fileURLToPath(second.uri), 'changed staging file')
  assert.equal(await inputBundleExists(left), true)
  assert.equal(
    await fs.readFile(new URL(left.uri), 'utf8'),
    'same immutable archive'
  )
  assert.deepEqual(await fs.readdir(path.dirname(fileURLToPath(left.uri))), [
    'input-bundle.v1.tar.zst'
  ])
})

test('an incomplete or invalid staging copy never occupies the final path', async () => {
  const source = await bundle()
  const run = randomUUID()
  const published = publishedInputBundleReference(source, run)
  await fs.writeFile(new URL(source.uri), 'corrupt')
  await assert.rejects(publishInputBundle(source, run), /differs/)
  assert.equal(await inputBundleExists(published), false)
  assert.deepEqual(
    await fs.readdir(path.dirname(fileURLToPath(published.uri))),
    []
  )
  const rebuilt = await bundle()
  assert.deepEqual(await publishInputBundle(rebuilt, run), published)
})

test('conflicting bytes at the final path are rejected without overwrite', async () => {
  const source = await bundle()
  const run = randomUUID()
  const destination = fileURLToPath(
    publishedInputBundleReference(source, run).uri
  )
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, 'conflicting bytes')
  await assert.rejects(publishInputBundle(source, run), /differs/)
  assert.equal(await fs.readFile(destination, 'utf8'), 'conflicting bytes')
})

for (const crash of [
  'reserved',
  'published',
  'confirmed',
  'committed'
] as const) {
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
          assert.deepEqual(intent, {
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
        assert.ok(candidate)
        if (status === 'present') crashOnce('published')
        candidate.status = status
        if (status === 'present') crashOnce('confirmed')
        return candidate
      },
      async submitPreparedRun(_run, _token, savedContext, input) {
        assert.ok(candidate)
        assert.deepEqual(savedContext, candidate.publish_context)
        assert.deepEqual(input, candidate.input)
        candidate.status = 'selected'
        crashOnce('committed')
      }
    }
    await assert.rejects(
      publishAndSubmitInputBundle(store, run, 'first', context, {
        input_bundle: source
      }),
      /worker stopped/
    )
    await fs.rm(fileURLToPath(source.uri))
    const recovered = await recoverInputBundlePublication(
      store,
      run,
      'takeover'
    )
    if (crash === 'reserved') {
      assert.equal(recovered, false)
      assert.equal(candidate?.status, 'abandoned')
      const rebuilt = await bundle()
      assert.notEqual(rebuilt.uri, source.uri)
      await publishAndSubmitInputBundle(store, run, 'takeover', context, {
        input_bundle: rebuilt
      })
    } else assert.equal(recovered, true)
    assert.equal(candidate?.status, 'selected')
    assert.equal(await inputBundleExists(candidate!.reference), true)
  })
}
