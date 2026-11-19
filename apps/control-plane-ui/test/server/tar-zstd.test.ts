import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import { zstdDecompressSync } from 'node:zlib'

import { validateRestrictedPaxTar } from '../../server/artifacts/tar-zstd.js'

import { TAR_ZSTD_CORPUS_ROOT as corpus } from '../support/contract-fixtures.js'

test('restricted PAX reader matches the shared corpus', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8')) as {
    corpus: Array<{ file: string; expected: 'valid' | 'invalid' }>
  }

  for (const item of manifest.corpus) {
    const read = (): void =>
      void validateRestrictedPaxTar(
        zstdDecompressSync(fs.readFileSync(path.join(corpus, item.file)))
      )
    if (item.expected === 'valid') {
      expect(read, item.file).not.toThrow()
    } else {
      expect(read, item.file).toThrow(
        expect.objectContaining({ message: 'invalid_tar_zstd_envelope' })
      )
    }
  }
})

test('restricted PAX reader returns the validated canonical header', () => {
  const entries = validateRestrictedPaxTar(
    zstdDecompressSync(fs.readFileSync(path.join(corpus, 'valid-ustar.tar.zst')))
  )

  expect(entries).toStrictEqual([
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
