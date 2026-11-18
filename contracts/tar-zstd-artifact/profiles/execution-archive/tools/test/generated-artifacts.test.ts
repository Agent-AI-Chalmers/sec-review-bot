import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

test('execution-archive corpus manifest covers every archive', () => {
  const corpus = path.resolve(import.meta.dirname, '../../v1/corpus')
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')
  ) as { corpus: { file: string }[] }
  expect(
    manifest.corpus.map((item: { file: string }) => item.file).sort()
  ).toStrictEqual(
    fs
      .readdirSync(corpus)
      .filter((name) => name.endsWith('.tar.zst'))
      .sort()
  )
})

test('generated artifact manifest covers the execution-archive corpus', () => {
  const toolRoot = path.resolve(import.meta.dirname, '..')
  const generated = JSON.parse(
    fs.readFileSync(path.join(toolRoot, 'generated-artifacts.json'), 'utf8')
  ) as { family: string; generators: { outputs: string[] }[] }
  expect(generated.family).toBe('tar-zstd-artifact/profiles/execution-archive')
  const corpus = path.resolve(toolRoot, '../v1/corpus')
  const expected = fs
    .readdirSync(corpus)
    .map(
      (name) =>
        `contracts/tar-zstd-artifact/profiles/execution-archive/v1/corpus/${name}`
    )
    .sort()
  expect.assert(generated.generators[0])
  expect(generated.generators[0].outputs.toSorted()).toStrictEqual(expected)
})
