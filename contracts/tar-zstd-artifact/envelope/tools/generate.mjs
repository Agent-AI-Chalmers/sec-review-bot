import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')
const corpus = path.join(root, 'v1', 'corpus')

function octal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function entry(name, type, body = Buffer.alloc(0), metadata = {}) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  octal(header, 100, 8, metadata.mode ?? (type === '5' ? 0o755 : 0o644))
  octal(header, 108, 8, metadata.uid ?? 0)
  octal(header, 116, 8, metadata.gid ?? 0)
  octal(header, 124, 12, body.length)
  octal(header, 136, 12, metadata.mtime ?? 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(metadata.uname ?? '', 265, 32, 'utf8')
  header.write(metadata.gname ?? '', 297, 32, 'utf8')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

function record(key, value) {
  const payload = `${key}=${value}\n`
  let length = Buffer.byteLength(payload) + 3
  for (;;) {
    const bytes = Buffer.from(`${length} ${payload}`)
    if (bytes.length === length) return bytes
    length = bytes.length
  }
}

function archive(parts) {
  return zstdCompressSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}

const longPath = `tree/${'a'.repeat(110)}.txt`
const definitions = [
  ['valid-ustar.tar.zst', 'valid', archive([entry('tree/file.txt', '0', Buffer.from('ok\n'))])],
  ['valid-pax-path.tar.zst', 'valid', archive([entry('PaxHeaders/path', 'x', record('path', longPath)), entry('PaxPath/file', '0', Buffer.from('ok\n'))])],
  ['invalid-global-pax.tar.zst', 'invalid', archive([entry('GlobalHead', 'g', record('path', longPath)), entry('tree/file.txt', '0', Buffer.from('ok\n'))])],
  ['invalid-pax-key.tar.zst', 'invalid', archive([entry('PaxHeaders/mtime', 'x', record('mtime', '1')), entry('tree/file.txt', '0', Buffer.from('ok\n'))])],
  ['invalid-gnu-longname.tar.zst', 'invalid', archive([entry('././@LongLink', 'L', Buffer.from(`${longPath}\0`)), entry('tree/file.txt', '0', Buffer.from('ok\n'))])],
  ['invalid-entry-type.tar.zst', 'invalid', archive([entry('tree/link', '2')])],
  ['invalid-mode.tar.zst', 'invalid', archive([entry('tree/file.txt', '0', Buffer.from('ok\n'), { mode: 0o600 })])],
  ['invalid-mtime.tar.zst', 'invalid', archive([entry('tree/file.txt', '0', Buffer.from('ok\n'), { mtime: 1 })])],
  ['invalid-owner.tar.zst', 'invalid', archive([entry('tree/file.txt', '0', Buffer.from('ok\n'), { uid: 1000, uname: 'owner' })])],
  ['invalid-directory-size.tar.zst', 'invalid', archive([entry('tree/', '5', Buffer.from('x'))])]
]

const manifest = {
  corpus: definitions.map(([file, expected, bytes]) => ({
    file,
    expected,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  }))
}
const outputs = new Map(definitions.map(([file, , bytes]) => [path.join(corpus, file), bytes]))
outputs.set(path.join(corpus, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))

fs.mkdirSync(corpus, { recursive: true })
for (const [target, bytes] of outputs) {
  if (process.argv.includes('--check')) {
    assert.deepEqual(fs.readFileSync(target), bytes, `${path.relative(root, target)} is stale`)
  } else {
    fs.writeFileSync(target, bytes)
  }
}
