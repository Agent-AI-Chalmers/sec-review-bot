// Copy the OpenAPI contract next to the compiled server, with a digest the server verifies.
//
// The container ships only `dist/`, so the contract has to travel with the compiled output;
// and because that copy is what the running server validates requests against, a stale or
// hand-edited file beside `server.js` must not be accepted silently. This writes the contract
// and its SHA-256 using the shared `contractDigest`, so the writer and the server's startup
// check cannot disagree about what "fresh" means.
// Run with `pnpm run copy:spec` (part of `pnpm run build`).
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { contractDigest } from '../src/contract-digest.js'

const moduleDirectory = import.meta.dirname
export const REVIEW_RUNS_ROOT = path.resolve(moduleDirectory, '..')
export const SPEC_PATH = path.resolve(
  REVIEW_RUNS_ROOT,
  '../../contracts/review-runs-api/v1/openapi.yaml'
)
export const DIST_DIR = path.resolve(REVIEW_RUNS_ROOT, 'dist')
export const BUILT_SPEC_PATH = path.join(DIST_DIR, 'openapi.yaml')
export const BUILT_DIGEST_PATH = `${BUILT_SPEC_PATH}.sha256`

/** The committed content of the `dist/openapi.yaml.sha256` companion file. */
export function renderDigestFile(contents: Buffer | string): string {
  return `${contractDigest(contents)}\n`
}

if (
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1])
) {
  const contents = readFileSync(SPEC_PATH)
  writeFileSync(BUILT_SPEC_PATH, contents)
  writeFileSync(BUILT_DIGEST_PATH, renderDigestFile(contents))
  console.log(
    `Wrote ${path.relative(process.cwd(), BUILT_SPEC_PATH)} and its digest`
  )
}
