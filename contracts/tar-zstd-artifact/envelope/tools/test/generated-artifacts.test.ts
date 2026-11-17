import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

test('shared corpus manifest covers every encoded archive', () => {
  const corpus = path.resolve(import.meta.dirname, '../../v1/corpus')
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')
  )
  expect(
    manifest.corpus.map((item: { file: string }) => item.file).sort()
  ).toStrictEqual(
    fs
      .readdirSync(corpus)
      .filter((name) => name.endsWith('.tar.zst'))
      .sort()
  )
})

test('generated artifact manifest covers the envelope corpus', () => {
  const toolRoot = path.resolve(import.meta.dirname, '..')
  const generated = JSON.parse(
    fs.readFileSync(path.join(toolRoot, 'generated-artifacts.json'), 'utf8')
  )
  expect(generated.family).toBe('tar-zstd-artifact/envelope')
  const corpus = path.resolve(toolRoot, '../v1/corpus')
  const expected = fs
    .readdirSync(corpus)
    .map((name) => `contracts/tar-zstd-artifact/envelope/v1/corpus/${name}`)
    .sort()
  expect(generated.generators[0].outputs.toSorted()).toStrictEqual(expected)
})
