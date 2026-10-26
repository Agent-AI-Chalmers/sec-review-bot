import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

import tar from 'tar-stream'

import {
  buildMemoryTreeArtifact,
  memoryTreeObjectKey,
  readMemoryTreeArtifact
} from '../server/memory/memory-tree-artifact.js'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
)

async function memoryTreeArchive(
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
    const type = item.type ?? 'file'
    await new Promise<void>((resolve, reject) => {
      const header = {
        name: item.name,
        type,
        size: body?.length ?? 0,
        mode: type === 'directory' ? 0o755 : 0o644,
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

await test('TypeScript memory tree artifacts round trip deterministically', async () => {
  const content = new Map<string, string>([
    ['topics/parsing.md', '# Parsing\n'],
    ['MEMORY.md', '# Index\n']
  ])

  const first = await buildMemoryTreeArtifact(content)
  const second = await buildMemoryTreeArtifact(content)
  const restored = await readMemoryTreeArtifact(first.bytes)

  assert.deepEqual(first.bytes, second.bytes)
  assert.equal(first.digest, second.digest)
  assert.equal(first.objectKey, memoryTreeObjectKey(first.digest))
  assert.equal(restored.get('MEMORY.md')?.toString('utf8'), '# Index\n')
  assert.equal(
    restored.get('topics/parsing.md')?.toString('utf8'),
    '# Parsing\n'
  )
})

await test('TypeScript memory tree builder rejects content outside the contract', async () => {
  await assert.rejects(
    buildMemoryTreeArtifact(
      new Map([
        ['MEMORY.md', '# Index\n'],
        ['topics/data.bin', 'not markdown']
      ])
    ),
    /Invalid memory tree content path/
  )
  await assert.rejects(
    buildMemoryTreeArtifact(new Map([['topics/topic.md', '# Topic\n']])),
    /requires MEMORY.md/
  )
})

await test('TypeScript memory tree entry limit includes parent directories', async () => {
  const content = new Map<string, string>([['MEMORY.md', '# Index\n']])
  for (let index = 0; index < 4999; index += 1)
    content.set(`topics/group-${index}/topic.md`, '# Topic\n')

  await assert.rejects(buildMemoryTreeArtifact(content), /entry count limit/)
})

await test('TypeScript memory tree builder uses PAX for long paths', async () => {
  const path = `topics/${'a'.repeat(101)}.md`
  const artifact = await buildMemoryTreeArtifact(
    new Map([
      ['MEMORY.md', '# Index\n'],
      [path, '# Topic\n']
    ])
  )
  const content = await readMemoryTreeArtifact(artifact.bytes)
  assert.equal(content.get(path)?.toString(), '# Topic\n')
})

await test('TypeScript memory tree reader rejects duplicate directory paths', async () => {
  await assert.rejects(
    readMemoryTreeArtifact(
      await memoryTreeArchive([
        { name: 'manifest.json', body: '{"version":1}\n' },
        { name: 'memory/', type: 'directory' },
        { name: 'memory/', type: 'directory' },
        { name: 'memory/MEMORY.md', body: '# Index\n' },
        { name: 'memory/topics/', type: 'directory' }
      ])
    ),
    /duplicate entry: memory\//
  )
})

await test('TypeScript reader matches the shared memory tree corpus', async () => {
  const fixtureRoot = path.join(
    repositoryRoot,
    'contracts',
    'tar-zstd-artifact',
    'profiles',
    'memory-tree',
    'v1',
    'corpus'
  )
  const manifest = JSON.parse(
    await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8')
  ) as { corpus: Array<{ file: string; expected: 'valid' | 'invalid' }> }

  for (const fixture of manifest.corpus) {
    const bytes = await readFile(path.join(fixtureRoot, fixture.file))
    if (fixture.expected === 'valid') {
      await readMemoryTreeArtifact(bytes)
    } else {
      await assert.rejects(readMemoryTreeArtifact(bytes))
    }
  }
})
