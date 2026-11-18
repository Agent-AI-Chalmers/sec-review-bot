import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const toolRoot = path.resolve(import.meta.dirname, '..')
const corpusRoot = path.resolve(toolRoot, '../v1/corpus')

test('input-bundle corpus manifest covers every archive', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8')
  ) as { corpus: { file: string }[] }
  expect(
    manifest.corpus.map((item: { file: string }) => item.file).sort()
  ).toStrictEqual(
    fs
      .readdirSync(corpusRoot)
      .filter((name) => name.endsWith('.tar.zst'))
      .sort()
  )
})

test('generated artifact manifest covers the input-bundle corpus', () => {
  const generated = JSON.parse(
    fs.readFileSync(path.join(toolRoot, 'generated-artifacts.json'), 'utf8')
  ) as { family: string; generators: { outputs: string[] }[] }
  expect(generated.family).toBe('tar-zstd-artifact/profiles/input-bundle')
  const expected = fs
    .readdirSync(corpusRoot)
    .map(
      (name) =>
        `contracts/tar-zstd-artifact/profiles/input-bundle/v1/corpus/${name}`
    )
    .sort()
  expect.assert(generated.generators[0])
  expect(generated.generators[0].outputs.toSorted()).toStrictEqual(expected)
})
