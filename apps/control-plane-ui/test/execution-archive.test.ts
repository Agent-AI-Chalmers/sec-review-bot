import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import tar from 'tar-stream'

import { readExecutionArchive } from '../server/run/execution-archive.js'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')

async function bundle(
  entries: Array<{
    name: string
    body?: Buffer | string
    type?: tar.Header['type']
  }>
): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collecting = (async (): Promise<void> => {
    for await (const chunk of pack as unknown as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk))
  })()
  for (const item of entries) {
    const body =
      item.body === undefined
        ? undefined
        : Buffer.isBuffer(item.body)
          ? item.body
          : Buffer.from(item.body)
    await new Promise<void>((resolve, reject) => {
      const header = {
        name: item.name,
        type: item.type ?? 'file',
        size: body?.length ?? 0,
        mtime: new Date(0),
        uid: 0,
        gid: 0
      }
      const done = (error?: Error | null): void =>
        error ? reject(error) : resolve()
      if (body === undefined) pack.entry(header, done)
      else pack.entry(header, body, done)
    })
  }
  pack.finalize()
  await collecting
  return zstdCompressSync(Buffer.concat(chunks))
}

function manifest(runId = 'run-1'): string {
  return JSON.stringify({
    version: 1,
    run_id: runId,
    result: 'result.json',
    review_units: [
      {
        id: 'unit-1',
        trajectories: ['artifact-tree/unit-1/review.jsonl']
      }
    ]
  })
}

test('execution archive reader exposes text and marks binary files unpreviewable', async () => {
  const view = await readExecutionArchive(
    await bundle([
      { name: 'manifest.json', body: manifest() },
      { name: 'result.json', body: '{"status":"completed"}' },
      {
        name: 'artifact-tree/unit-1/review.jsonl',
        body: '{"event":"message"}\n'
      },
      {
        name: 'artifact-tree/unit-1/evidence.bin',
        body: Buffer.from([0, 1, 2])
      }
    ]),
    'run-1'
  )

  assert.equal(view.files['result.json'], '{"status":"completed"}')
  assert.equal(
    view.files['artifact-tree/unit-1/review.jsonl'],
    '{"event":"message"}\n'
  )
  assert.deepEqual(
    view.unpreviewableFiles['artifact-tree/unit-1/evidence.bin'],
    { sizeBytes: 3 }
  )
})

test('execution archive reader rejects another run and unsafe archive paths', async () => {
  await assert.rejects(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest('run-2') },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/unit-1/review.jsonl', body: '' }
      ]),
      'run-1'
    ),
    /invalid_execution_archive/
  )
  await assert.rejects(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest() },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/unit-1/review.jsonl', body: '' },
        { name: '../outside', body: 'no' }
      ]),
      'run-1'
    ),
    /invalid_execution_archive/
  )
})

test('execution archive reader rejects links and missing manifest entries', async () => {
  await assert.rejects(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest() },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/unit-1/review.jsonl', type: 'symlink' }
      ]),
      'run-1'
    ),
    /invalid_execution_archive/
  )
  await assert.rejects(
    readExecutionArchive(
      await bundle([{ name: 'result.json', body: '{}' }]),
      'run-1'
    ),
    /invalid_execution_archive/
  )
})

test('execution archive reader matches the shared profile corpus', async () => {
  const corpus = path.join(
    repositoryRoot,
    'contracts',
    'tar-zstd-artifact',
    'profiles',
    'execution-archive',
    'v1',
    'corpus'
  )
  const manifest = JSON.parse(
    await readFile(path.join(corpus, 'manifest.json'), 'utf8')
  ) as {
    corpus: Array<{
      file: string
      expected: 'valid' | 'invalid'
      runId: string
    }>
  }

  for (const item of manifest.corpus) {
    const read = readExecutionArchive(
      await readFile(path.join(corpus, item.file)),
      item.runId
    )
    if (item.expected === 'valid') await read
    else await assert.rejects(read, /invalid_execution_archive/, item.file)
  }
})

test('execution archive reader rejects duplicate directory paths', async () => {
  await assert.rejects(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest() },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/', type: 'directory' },
        { name: 'artifact-tree/', type: 'directory' },
        { name: 'artifact-tree/unit-1/review.jsonl', body: '' }
      ]),
      'run-1'
    ),
    /invalid_execution_archive/
  )
})
