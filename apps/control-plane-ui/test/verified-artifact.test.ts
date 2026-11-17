import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'

import { withVerifiedArtifactFile } from '../server/artifacts/verified-artifact.js'

for (const failure of ['metadata', 'storage'] as const) {
  test(`artifact ${failure} rejection closes a pending file before removing its directory`, async () => {
    // A busy filesystem can finish opening the sink after metadata rejects the download.
    // Delay the real open to make that ordering deterministic instead of relying on CI load.
    const open = fs.open
    const close = fs.close
    let filename = ''
    const observedClose = vi
      .spyOn(fs, 'close')
      .mockImplementation((...args: Parameters<typeof fs.close>) => {
        expect(
          fs.existsSync(path.dirname(filename)),
          'the directory must survive until the sink closes'
        ).toBe(true)
        return close(...args)
      })
    const delayedOpen = vi
      .spyOn(fs, 'open')
      .mockImplementation((...args: Parameters<typeof fs.open>) => {
        filename = String(args[0])
        setTimeout(() => open(...args), 25)
      })
    try {
      await expect(
        withVerifiedArtifactFile(
          {
            getObject: async () => {
              if (failure === 'storage') throw new Error('storage unavailable')
              return { body: Readable.from(['wrong']), contentLength: 5 }
            }
          },
          {
            key: 'artifact',
            digest: `sha256:${'a'.repeat(64)}`,
            sizeBytes: 8,
            maximumSize: 8
          },
          { idleTimeoutMs: 1000, filename: 'artifact.tar.zst' },
          async () =>
            expect.unreachable('an unverified artifact must not be served')
        )
      ).rejects.toThrow(
        failure === 'metadata'
          ? /artifact_identity_mismatch/
          : /storage unavailable/
      )
      expect(
        observedClose.mock.calls.length,
        'rejection must wait for the sink to close'
      ).toBe(1)
      expect(fs.existsSync(path.dirname(filename))).toBe(false)
    } finally {
      delayedOpen.mockRestore()
      observedClose.mockRestore()
    }
  })
}
