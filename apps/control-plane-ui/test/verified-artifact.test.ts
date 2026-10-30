import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { mock, test } from 'node:test'

import { withVerifiedArtifactFile } from '../server/artifacts/verified-artifact.js'

for (const failure of ['metadata', 'storage'] as const) {
  test(`artifact ${failure} rejection closes a pending file before removing its directory`, async () => {
    // A busy filesystem can finish opening the sink after metadata rejects the download.
    // Delay the real open to make that ordering deterministic instead of relying on CI load.
    const open = fs.open
    const close = fs.close
    let filename = ''
    const observedClose = mock.method(
      fs,
      'close',
      (...args: Parameters<typeof fs.close>) => {
        assert.equal(
          fs.existsSync(path.dirname(filename)),
          true,
          'the directory must survive until the sink closes'
        )
        return close(...args)
      }
    )
    const delayedOpen = mock.method(
      fs,
      'open',
      (...args: Parameters<typeof fs.open>) => {
        filename = String(args[0])
        setTimeout(() => open(...args), 25)
      }
    )
    try {
      await assert.rejects(
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
          async () => assert.fail('an unverified artifact must not be served')
        ),
        failure === 'metadata'
          ? /artifact_identity_mismatch/
          : /storage unavailable/
      )
      assert.equal(
        observedClose.mock.callCount(),
        1,
        'rejection must wait for the sink to close'
      )
      assert.equal(fs.existsSync(path.dirname(filename)), false)
    } finally {
      delayedOpen.mock.restore()
      observedClose.mock.restore()
    }
  })
}
