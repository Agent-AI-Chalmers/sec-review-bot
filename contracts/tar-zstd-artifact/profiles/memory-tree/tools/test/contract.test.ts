import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

import { Ajv2020 } from 'ajv/dist/2020.js'

import { MEDIA_TYPE, sha256, validateArchive } from '../src/archive.js'
import { FIXTURE_ROOT, CONTRACT_ROOT } from '../src/paths.js'

interface FixtureRecord {
  file: string
  description: string
  mediaType: string
  sha256: string
  size: number
  expected: 'valid' | 'invalid'
  expectedCode: string | null
  objectKey: string
  entryCount: number
  entries?: Array<{ path: string; kind: string; sizeBytes: number }>
}

const corpusManifest = JSON.parse(
  readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8')
) as {
  corpus: FixtureRecord[]
}

test.each([
  { name: 'v1 manifest', value: { version: 1 }, valid: true },
  { name: 'unsupported version', value: { version: 2 }, valid: false },
  {
    name: 'additional field',
    value: { version: 1, extra: true },
    valid: false
  },
  { name: 'missing version', value: {}, valid: false }
])('archive manifest schema: $name', ({ value, valid }) => {
  const schema = JSON.parse(
    readFileSync(path.join(CONTRACT_ROOT, 'v1', 'manifest.schema.json'), 'utf8')
  ) as object
  const validate = new Ajv2020({ strict: true }).compile(schema)

  expect(validate(value), JSON.stringify(validate.errors)).toBe(valid)
})

test('the fixture manifest covers every committed archive exactly once', () => {
  const archiveFiles = readdirSync(FIXTURE_ROOT)
    .filter((file) => file.endsWith('.tar.zst'))
    .sort()
  const declaredFiles = corpusManifest.corpus.map(({ file }) => file).sort()

  expect(declaredFiles).toStrictEqual(archiveFiles)
  expect(new Set(declaredFiles).size).toBe(declaredFiles.length)
})

for (const fixture of corpusManifest.corpus) {
  test(`${fixture.file} matches its bytes and expected validation result`, () => {
    const archive = readFileSync(path.join(FIXTURE_ROOT, fixture.file))
    const digest = sha256(archive)
    const result = validateArchive(archive)

    expect(fixture.mediaType).toBe(MEDIA_TYPE)
    expect.assert(fixture.description.length > 0)
    expect.assert(fixture.entryCount > 0)
    if (fixture.entries !== undefined) expect(fixture.entries).toHaveLength(fixture.entryCount)
    expect(fixture.size).toBe(archive.length)
    expect(fixture.sha256).toBe(digest)
    expect(fixture.objectKey).toBe(`memory/trees/${digest}/memory-tree.v1.tar.zst`)
    expect(result.valid).toBe(fixture.expected === 'valid')
    expect(result.code).toBe(fixture.expectedCode)
  })
}
