import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const profileRoot = path.resolve(import.meta.dirname, '../..')
const corpusRoot = path.join(profileRoot, 'v1', 'corpus')

function writeOctal(header: Buffer, offset: number, length: number, value: number) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function rawEntry(name: string, type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  writeOctal(header, 100, 8, type === '5' ? 0o755 : 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, body.length)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

function paxRecord(value: string): Buffer {
  const payload = `path=${value}\n`
  let length = Buffer.byteLength(payload) + 3
  for (;;) {
    const record = Buffer.from(`${length} ${payload}`)
    if (record.length === length) {
      return record
    }
    length = record.length
  }
}

type EntrySpec = [name: string, type: string, body?: Buffer]

function entry(name: string, type: string, body: Buffer = Buffer.alloc(0)): Buffer[] {
  if (Buffer.byteLength(name) <= 100) {
    return [rawEntry(name, type, body)]
  }
  const marker = crypto.createHash('sha256').update(name).digest('hex').slice(0, 24)
  return [
    rawEntry(`PaxHeaders/${marker}`, 'x', paxRecord(name)),
    rawEntry(`PaxPath/${marker}`, type, body)
  ]
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function manifest(trajectories: string[], overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    result: 'result.json',
    review_units: [{ id: 'unit-1', trajectories }],
    ...overrides
  }
}

function archive(entries: EntrySpec[]): Buffer {
  return zstdCompressSync(
    Buffer.concat([...entries.flatMap((item) => entry(...item)), Buffer.alloc(1024)])
  )
}

const trajectory = 'artifact-tree/unit-1/review.jsonl'
const longTrajectory = `artifact-tree/unit-1/${'a'.repeat(110)}.jsonl`
const nonCanonicalTrajectory = 'artifact-tree/unit-1/./review.jsonl'
const wrongExtensionTrajectory = 'artifact-tree/unit-1/review.txt'
const definitions = [
  {
    file: 'valid-minimal.tar.zst',
    expected: 'valid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([trajectory]))],
      ['result.json', '0', json({ status: 'completed' })],
      ['artifact-tree/', '5'],
      ['artifact-tree/unit-1/', '5'],
      [trajectory, '0', Buffer.from('{"event":"message"}\n')]
    ])
  },
  {
    file: 'valid-pax-path.tar.zst',
    expected: 'valid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([longTrajectory]))],
      ['result.json', '0', json({ status: 'completed' })],
      ['artifact-tree/', '5'],
      ['artifact-tree/unit-1/', '5'],
      [longTrajectory, '0', Buffer.from('{"event":"message"}\n')]
    ])
  },
  {
    file: 'invalid-result-reference.tar.zst',
    expected: 'invalid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([trajectory], { result: 'other.json' }))],
      ['result.json', '0', json({})],
      ['artifact-tree/', '5'],
      [trajectory, '0', Buffer.from('{}\n')]
    ])
  },
  {
    file: 'invalid-missing-trajectory.tar.zst',
    expected: 'invalid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([trajectory]))],
      ['result.json', '0', json({})],
      ['artifact-tree/', '5']
    ])
  },
  {
    file: 'invalid-noncanonical-trajectory-path.tar.zst',
    expected: 'invalid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([nonCanonicalTrajectory]))],
      ['result.json', '0', json({})],
      ['artifact-tree/', '5'],
      [trajectory, '0', Buffer.from('{}\n')]
    ])
  },
  {
    file: 'invalid-trajectory-extension.tar.zst',
    expected: 'invalid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([wrongExtensionTrajectory]))],
      ['result.json', '0', json({})],
      ['artifact-tree/', '5'],
      [wrongExtensionTrajectory, '0', Buffer.from('{}\n')]
    ])
  },
  {
    file: 'invalid-duplicate-unit.tar.zst',
    expected: 'invalid',
    unitId: 'unit-1',
    bytes: archive([
      [
        'manifest.json',
        '0',
        json(
          manifest([trajectory], {
            review_units: [
              { id: 'unit-1', trajectories: [trajectory] },
              { id: 'unit-1', trajectories: [trajectory] }
            ]
          })
        )
      ],
      ['result.json', '0', json({})],
      ['artifact-tree/', '5'],
      [trajectory, '0', Buffer.from('{}\n')]
    ])
  },
  {
    file: 'invalid-symlink.tar.zst',
    expected: 'invalid',
    unitId: 'unit-1',
    bytes: archive([
      ['manifest.json', '0', json(manifest([trajectory]))],
      ['result.json', '0', json({})],
      ['artifact-tree/', '5'],
      [trajectory, '2']
    ])
  }
]

const manifestValue = {
  corpus: definitions.map(({ file, expected, unitId, bytes }) => ({
    file,
    expected,
    runId: 'run-1',
    unitId,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  }))
}
const outputs = new Map(definitions.map(({ file, bytes }) => [path.join(corpusRoot, file), bytes]))
outputs.set(
  path.join(corpusRoot, 'manifest.json'),
  Buffer.from(`${JSON.stringify(manifestValue, null, 2)}\n`)
)

fs.mkdirSync(corpusRoot, { recursive: true })
for (const [target, bytes] of outputs) {
  if (process.argv.includes('--check')) {
    assert.deepEqual(
      fs.readFileSync(target),
      bytes,
      `${path.relative(profileRoot, target)} is stale`
    )
  } else {
    fs.writeFileSync(target, bytes)
  }
}
