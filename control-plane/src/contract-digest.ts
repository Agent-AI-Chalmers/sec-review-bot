// The one definition of the built contract's digest.
//
// Lives in `src/` so both sides can reach it: the build script (`scripts/copy-contract.ts`)
// writes `dist/openapi.yaml.sha256` with it, and the server re-computes it at startup to
// verify the copy beside itself. Sharing the function is what makes the writer and the
// verifier agree on what "fresh" means.
import { createHash } from 'node:crypto'

/** The SHA-256 of the given contract contents, as the digest companion file records it. */
export function contractDigest(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex')
}
