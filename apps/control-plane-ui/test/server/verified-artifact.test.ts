import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'

import { withVerifiedArtifactFile } from '../../server/artifacts/verified-artifact.js'

for (const failure of ['metadata', 'storage'] as const) {
  test(`artifact ${failure} rejection closes a pending file before removing its directory`, async () => {
    // A busy filesystem can finish opening the sink after metadata rejects the download.
    // Hold the real open until failure cleanup destroys the sink, then let it finish.
    const open = fs.open
    const close = fs.close
    const rm = fsPromises.rm
    // Capture before spying; invoke with .call(this, error) below to retain the receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const destroy = fs.WriteStream.prototype.destroy
    const pendingOpen = Promise.withResolvers<void>()
    const releaseOpen = Promise.withResolvers<void>()
    const sinkDestroyed = Promise.withResolvers<void>()
    let filename = ''
    // Record observations inside the spies and assert after completion, so cleanup code
    // that catches close/rm errors cannot swallow a failed ordering assertion.
    const directoryExistedAtClose: boolean[] = []
    const closesBeforeRemoval: number[] = []
    const observedClose = vi
      .spyOn(fs, 'close')
      .mockImplementation((...args: Parameters<typeof fs.close>) => {
        directoryExistedAtClose.push(fs.existsSync(path.dirname(filename)))
        return close(...args)
      })
    const delayedOpen = vi
      .spyOn(fs, 'open')
      .mockImplementation((...args: Parameters<typeof fs.open>) => {
        filename = String(args[0])
        pendingOpen.resolve()
        void releaseOpen.promise.then(() => open(...args))
      })
    const observedDestroy = vi
      .spyOn(fs.WriteStream.prototype, 'destroy')
      .mockImplementation(function (this: fs.WriteStream, error) {
        sinkDestroyed.resolve()
        return destroy.call(this, error)
      })
    const observedRemoval = vi
      .spyOn(fsPromises, 'rm')
      .mockImplementation(async (...args: Parameters<typeof fsPromises.rm>) => {
        closesBeforeRemoval.push(observedClose.mock.calls.length)
        await rm(...args)
      })
    // The implementation uses the named fs/promises export; keep it bound to the spy.
    syncBuiltinESMExports()
    let completion: Promise<void> | undefined
    try {
      completion = expect(
        withVerifiedArtifactFile(
          {
            getObject: async () => {
              if (failure === 'storage') {
                throw new Error('storage unavailable')
              }
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
          async () => expect.unreachable('an unverified artifact must not be served')
        )
      ).rejects.toThrow(
        failure === 'metadata' ? /artifact_identity_mismatch/ : /storage unavailable/
      )
      await pendingOpen.promise
      await sinkDestroyed.promise
      expect(observedClose).not.toHaveBeenCalled()
      expect(fs.existsSync(path.dirname(filename))).toBe(true)
      releaseOpen.resolve()
      await completion
      expect(observedClose, 'rejection must wait for the sink to close').toHaveBeenCalledTimes(1)
      expect(directoryExistedAtClose, 'the directory must survive until the sink closes').toEqual([
        true
      ])
      expect(closesBeforeRemoval, 'directory removal must start after the file closes').toEqual([1])
      expect(fs.existsSync(path.dirname(filename))).toBe(false)
    } finally {
      releaseOpen.resolve()
      try {
        await completion
      } finally {
        observedRemoval.mockRestore()
        observedDestroy.mockRestore()
        delayedOpen.mockRestore()
        observedClose.mockRestore()
        syncBuiltinESMExports()
      }
    }
  })
}
