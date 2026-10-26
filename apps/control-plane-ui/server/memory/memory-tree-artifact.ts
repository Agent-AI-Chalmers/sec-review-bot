import crypto from 'node:crypto'
import { TextDecoder } from 'node:util'
import { zstdCompressSync } from 'node:zlib'

import tar from 'tar-stream'

import { decompressRestrictedPaxArchive } from '../artifacts/tar-zstd.js'

export const MEMORY_TREE_MEDIA_TYPE = 'application/tar+zstd'
export const MEMORY_TREE_FILENAME = 'memory-tree.v1.tar.zst'
export const MAX_MEMORY_TREE_ARTIFACT_BYTES = 64 * 1024 * 1024
export const MAX_MEMORY_TREE_ENTRIES = 10_000
export const MAX_MEMORY_TREE_FILE_BYTES = 16 * 1024 * 1024
export const MAX_MEMORY_TREE_EXTRACTED_BYTES = 256 * 1024 * 1024

const MANIFEST = Buffer.from('{"version":1}\n', 'utf8')
const utf8 = new TextDecoder('utf-8', { fatal: true })

function compareArchivePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export interface BuiltMemoryTreeArtifact {
  bytes: Buffer
  digest: string
  mediaType: typeof MEMORY_TREE_MEDIA_TYPE
  objectKey: string
  sizeBytes: number
}

function validateContentPath(name: string): void {
  if (name === 'MEMORY.md') return
  if (
    !name.startsWith('topics/') ||
    !name.endsWith('.md') ||
    name.includes('\\') ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid memory tree content path: ${name}`)
  }
}

function validateTextFile(name: string, value: Buffer): void {
  if (value.length > MAX_MEMORY_TREE_FILE_BYTES)
    throw new Error(`Memory tree file exceeds the size limit: ${name}`)
  try {
    utf8.decode(value)
  } catch {
    throw new Error(`Memory tree file is not valid UTF-8: ${name}`)
  }
}

function writeTarString(
  target: Buffer,
  offset: number,
  length: number,
  value: string
): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length)
    throw new Error(`Memory tree tar field is too long: ${value}`)
  bytes.copy(target, offset)
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  writeTarString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`
  )
}

function splitUstarPath(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix: '' }
  for (let index = name.length - 2; index > 0; index -= 1) {
    if (name[index] !== '/') continue
    const prefix = name.slice(0, index)
    const suffix = name.slice(index + 1)
    if (
      Buffer.byteLength(prefix, 'utf8') <= 155 &&
      Buffer.byteLength(suffix, 'utf8') <= 100
    )
      return { name: suffix, prefix }
  }
  throw new Error(`Memory tree path does not fit POSIX ustar fields: ${name}`)
}

function paxRecord(key: string, value: string): Buffer {
  const payload = `${key}=${value}\n`
  let length = Buffer.byteLength(payload, 'utf8') + 3
  for (;;) {
    const record = Buffer.from(`${length} ${payload}`, 'utf8')
    if (record.length === length) return record
    length = record.length
  }
}

function rawUstarEntry(
  name: string,
  body: Buffer | undefined,
  type?: 'file' | 'directory' | 'pax'
): Buffer[] {
  const header = Buffer.alloc(512)
  const split = splitUstarPath(name)
  const directory =
    type === 'directory' || (type === undefined && body === undefined)
  writeTarString(header, 0, 100, split.name)
  writeTarOctal(header, 100, 8, directory ? 0o755 : 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, body?.length ?? 0)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  writeTarString(header, 156, 1, type === 'pax' ? 'x' : directory ? '5' : '0')
  writeTarString(header, 257, 6, 'ustar\0')
  writeTarString(header, 263, 2, '00')
  writeTarString(header, 345, 155, split.prefix)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  if (body === undefined) return [header]
  const padding = (512 - (body.length % 512)) % 512
  return padding === 0 ? [header, body] : [header, body, Buffer.alloc(padding)]
}

function paxEntry(name: string, body: Buffer | undefined): Buffer[] {
  try {
    return rawUstarEntry(name, body)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ustar fields'))
      throw error
    const marker = crypto
      .createHash('sha256')
      .update(name)
      .digest('hex')
      .slice(0, 24)
    return [
      ...rawUstarEntry(`PaxHeaders/${marker}`, paxRecord('path', name), 'pax'),
      ...rawUstarEntry(`PaxPath/${marker}`, body)
    ]
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export function memoryTreeObjectKey(digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error('Memory tree key requires a lowercase SHA-256 digest.')
  return `memory/trees/${digest.slice('sha256:'.length)}/${MEMORY_TREE_FILENAME}`
}

export async function buildMemoryTreeArtifact(
  content: ReadonlyMap<string, Buffer | string>
): Promise<BuiltMemoryTreeArtifact> {
  if (!content.has('MEMORY.md'))
    throw new Error('Memory tree requires MEMORY.md.')
  const files = [...content.entries()]
    .map(
      ([name, value]) =>
        [name, Buffer.isBuffer(value) ? value : Buffer.from(value)] as const
    )
    .sort(([left], [right]) => compareArchivePaths(left, right))
  let extractedBytes = MANIFEST.length
  for (const [name, value] of files) {
    validateContentPath(name)
    validateTextFile(name, value)
    extractedBytes += value.length
  }
  if (extractedBytes > MAX_MEMORY_TREE_EXTRACTED_BYTES)
    throw new Error('Memory tree exceeds the extracted size limit.')
  const directories = new Set<string>(['memory/topics/'])
  for (const [name] of files) {
    const parts = name.split('/').slice(0, -1)
    let current = 'memory/'
    for (const part of parts) {
      current += `${part}/`
      directories.add(current)
    }
  }
  const orderedEntries = [
    ...[...directories].map((name) => ({ name, directory: true as const })),
    ...files.map(([name, value]) => ({
      name: `memory/${name}`,
      directory: false as const,
      value
    }))
  ].sort((left, right) => compareArchivePaths(left.name, right.name))
  if (orderedEntries.length + 2 > MAX_MEMORY_TREE_ENTRIES)
    throw new Error('Memory tree exceeds the entry count limit.')
  const tarParts = [
    ...paxEntry('manifest.json', MANIFEST),
    ...paxEntry('memory/', undefined)
  ]
  for (const item of orderedEntries) {
    tarParts.push(
      ...paxEntry(item.name, item.directory ? undefined : item.value)
    )
  }
  tarParts.push(Buffer.alloc(1024))
  const bytes = zstdCompressSync(Buffer.concat(tarParts))
  if (bytes.length > MAX_MEMORY_TREE_ARTIFACT_BYTES)
    throw new Error('Memory tree archive exceeds the size limit.')
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
  return {
    bytes,
    digest,
    mediaType: MEMORY_TREE_MEDIA_TYPE,
    objectKey: memoryTreeObjectKey(digest),
    sizeBytes: bytes.length
  }
}

export async function readMemoryTreeArtifact(
  bytes: Buffer
): Promise<Map<string, Buffer>> {
  if (bytes.length > MAX_MEMORY_TREE_ARTIFACT_BYTES)
    throw new Error('Memory tree archive exceeds the size limit.')
  const tarBytes = decompressRestrictedPaxArchive(
    bytes,
    MAX_MEMORY_TREE_EXTRACTED_BYTES + MAX_MEMORY_TREE_ENTRIES * 2048
  )
  const extract = tar.extract()
  const result = new Map<string, Buffer>()
  let count = 0
  let extractedBytes = 0
  let previousName = ''
  const seenPaths = new Set<string>()
  let sawManifest = false
  let sawMemoryDirectory = false
  let sawTopicsDirectory = false

  const completed = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      void (async (): Promise<void> => {
        count += 1
        if (count > MAX_MEMORY_TREE_ENTRIES)
          throw new Error('Memory tree exceeds the entry count limit.')
        const name = header.name
        if (seenPaths.has(name))
          throw new Error(`Memory tree contains a duplicate entry: ${name}`)
        seenPaths.add(name)
        if (count === 1 && name !== 'manifest.json')
          throw new Error('Memory tree manifest must be the first entry.')
        if (
          previousName &&
          name !== 'memory/' &&
          compareArchivePaths(name, previousName) <= 0
        )
          throw new Error('Memory tree entries are not in canonical order.')
        previousName = name
        if (
          header.mtime?.getTime() !== 0 ||
          header.uid !== 0 ||
          header.gid !== 0 ||
          (header.uname ?? '') !== '' ||
          (header.gname ?? '') !== ''
        )
          throw new Error(
            `Memory tree entry metadata is not canonical: ${name}`
          )

        const body = await collect(
          stream as unknown as AsyncIterable<Uint8Array>
        )
        extractedBytes += body.length
        if (extractedBytes > MAX_MEMORY_TREE_EXTRACTED_BYTES)
          throw new Error('Memory tree exceeds the extracted size limit.')
        if (name === 'manifest.json') {
          if (
            header.type !== 'file' ||
            header.mode !== 0o644 ||
            !body.equals(MANIFEST)
          )
            throw new Error('Memory tree manifest is invalid.')
          sawManifest = true
        } else if (
          name === 'memory/' ||
          name === 'memory/topics/' ||
          (name.startsWith('memory/topics/') && name.endsWith('/'))
        ) {
          if (header.type !== 'directory' || header.mode !== 0o755)
            throw new Error(`Memory tree directory is invalid: ${name}`)
          if (name === 'memory/') sawMemoryDirectory = true
          if (name === 'memory/topics/') sawTopicsDirectory = true
        } else if (name.startsWith('memory/')) {
          const relative = name.slice('memory/'.length)
          validateContentPath(relative)
          if (header.type !== 'file' || header.mode !== 0o644)
            throw new Error(`Memory tree file is invalid: ${name}`)
          validateTextFile(relative, body)
          result.set(relative, body)
        } else {
          throw new Error(`Unexpected memory tree entry: ${name}`)
        }
        next()
      })().catch(reject)
    })
    extract.on('finish', resolve)
    extract.on('error', reject)
  })
  extract.end(tarBytes)
  await completed
  if (
    !sawManifest ||
    !sawMemoryDirectory ||
    !sawTopicsDirectory ||
    !result.has('MEMORY.md')
  )
    throw new Error('Memory tree required entries are missing.')
  return result
}
