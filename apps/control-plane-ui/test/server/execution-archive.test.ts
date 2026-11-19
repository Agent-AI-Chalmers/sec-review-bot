import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { zstdCompressSync } from 'node:zlib'

import tar from 'tar-stream'

import { readExecutionArchive } from '../../server/run/execution-archive.js'

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..')

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
    for await (const chunk of pack) {
      expect.assert(chunk instanceof Uint8Array)
      chunks.push(Buffer.from(chunk))
    }
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
      const done = (error?: Error | null): void => (error ? reject(error) : resolve())
      if (body === undefined) {
        pack.entry(header, done)
      } else {
        pack.entry(header, body, done)
      }
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

test('execution archive reader rejects non-byte chunks from its parser', async () => {
  // Array chunks preserve valid archive contents but must not be silently coerced by Buffer.from.
  const bytes = await bundle([
    { name: 'manifest.json', body: manifest() },
    { name: 'result.json', body: '{"status":"completed"}' },
    { name: 'artifact-tree/unit-1/review.jsonl', body: '{}\n' }
  ])
  const extract = tar.extract()
  extract.on('entry', (_header, stream) => {
    const iterator = stream[Symbol.asyncIterator]()
    vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(async function* () {
      try {
        for (let chunk = await iterator.next(); !chunk.done; chunk = await iterator.next()) {
          expect.assert(chunk.value instanceof Uint8Array)
          yield Array.from(chunk.value)
        }
      } finally {
        await iterator.return?.()
      }
    })
  })
  const extracting = vi.spyOn(tar, 'extract').mockReturnValueOnce(extract)
  try {
    await expect(readExecutionArchive(bytes, 'run-1')).rejects.toThrow('invalid_execution_archive')
  } finally {
    extracting.mockRestore()
    extract.destroy()
  }
})

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

  expect(view.files['result.json']).toBe('{"status":"completed"}')
  expect(view.files['artifact-tree/unit-1/review.jsonl']).toBe('{"event":"message"}\n')
  expect(view.unpreviewableFiles['artifact-tree/unit-1/evidence.bin']).toStrictEqual({
    sizeBytes: 3
  })
})

test('execution archive reader rejects another run and unsafe archive paths', async () => {
  await expect(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest('run-2') },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/unit-1/review.jsonl', body: '' }
      ]),
      'run-1'
    )
  ).rejects.toThrow(/invalid_execution_archive/)
  await expect(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest() },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/unit-1/review.jsonl', body: '' },
        { name: '../outside', body: 'no' }
      ]),
      'run-1'
    )
  ).rejects.toThrow(/invalid_execution_archive/)
})

test('execution archive reader rejects links and missing manifest entries', async () => {
  await expect(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest() },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/unit-1/review.jsonl', type: 'symlink' }
      ]),
      'run-1'
    )
  ).rejects.toThrow(/invalid_execution_archive/)
  await expect(
    readExecutionArchive(await bundle([{ name: 'result.json', body: '{}' }]), 'run-1')
  ).rejects.toThrow(/invalid_execution_archive/)
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
  const manifest = JSON.parse(await readFile(path.join(corpus, 'manifest.json'), 'utf8')) as {
    corpus: Array<{
      file: string
      expected: 'valid' | 'invalid'
      runId: string
    }>
  }

  for (const item of manifest.corpus) {
    const read = readExecutionArchive(await readFile(path.join(corpus, item.file)), item.runId)
    if (item.expected === 'valid') {
      await read
    } else {
      await expect(read, item.file).rejects.toThrow(/invalid_execution_archive/)
    }
  }
})

test('execution archive reader rejects duplicate directory paths', async () => {
  await expect(
    readExecutionArchive(
      await bundle([
        { name: 'manifest.json', body: manifest() },
        { name: 'result.json', body: '{}' },
        { name: 'artifact-tree/', type: 'directory' },
        { name: 'artifact-tree/', type: 'directory' },
        { name: 'artifact-tree/unit-1/review.jsonl', body: '' }
      ]),
      'run-1'
    )
  ).rejects.toThrow(/invalid_execution_archive/)
})
