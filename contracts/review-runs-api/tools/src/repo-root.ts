// The repository root, reached from `<repo>/contracts/review-runs-api/tools/src`.
//
// Every artifact path a generator declares is absolute, built from here, so a generator can
// write into whichever package the projection belongs to without that package rendering it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
)
