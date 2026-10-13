// The build's contract digest must match what the server verifies at startup.
//
// `copy:spec` writes `dist/openapi.yaml` with a `.sha256` companion, and the server recomputes
// that digest from the copy beside it before trusting it. Both sides share `contractDigest`,
// so this pins the properties the pair relies on: the same bytes hash the same, different
// bytes do not, and the companion file is the bare hex digest plus a newline.
import assert from 'node:assert/strict'
import test from 'node:test'

import { contractDigest } from '../src/contract-digest.js'
import { renderDigestFile } from '../scripts/copy-contract.js'

test('the same contract contents always produce the same digest', () => {
  const contents = 'openapi: 3.1.0\n'
  assert.equal(contractDigest(contents), contractDigest(Buffer.from(contents)))
  assert.match(contractDigest(contents), /^[0-9a-f]{64}$/)
})

test('a changed contract produces a different digest', () => {
  assert.notEqual(contractDigest('openapi: 3.1.0\n'), contractDigest('openapi: 3.1.0\n# x\n'))
})

test('the digest file is the bare hex digest plus a newline', () => {
  const contents = 'openapi: 3.1.0\n'
  assert.equal(renderDigestFile(contents), `${contractDigest(contents)}\n`)
})
