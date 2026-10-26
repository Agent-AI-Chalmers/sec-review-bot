import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('shared corpus manifest covers every encoded archive', () => {
  const corpus = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'v1', 'corpus')
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'))
  assert.deepEqual(
    manifest.corpus.map((item) => item.file).sort(),
    fs.readdirSync(corpus).filter((name) => name.endsWith('.tar.zst')).sort()
  )
})
