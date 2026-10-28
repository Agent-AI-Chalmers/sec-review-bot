import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'

import { validateRestrictedPaxTar } from '../server/artifacts/tar-zstd.js'

const corpus = path.resolve(
  import.meta.dirname,
  '../../../contracts/tar-zstd-artifact/envelope/v1/corpus'
)

test('restricted PAX reader matches the shared corpus', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')
  ) as { corpus: Array<{ file: string; expected: 'valid' | 'invalid' }> }

  for (const item of manifest.corpus) {
    const read = (): void =>
      void validateRestrictedPaxTar(
        zstdDecompressSync(fs.readFileSync(path.join(corpus, item.file)))
      )
    if (item.expected === 'valid') assert.doesNotThrow(read, item.file)
    else
      assert.throws(read, { message: 'invalid_tar_zstd_envelope' }, item.file)
  }
})

test('restricted PAX reader returns the validated canonical header', () => {
  const entries = validateRestrictedPaxTar(
    zstdDecompressSync(
      fs.readFileSync(path.join(corpus, 'valid-ustar.tar.zst'))
    )
  )

  assert.deepEqual(entries, [
    {
      path: 'tree/file.txt',
      typeFlag: '0',
      size: 3,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: 0,
      uname: '',
      gname: ''
    }
  ])
})
