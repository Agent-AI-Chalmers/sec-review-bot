// Contract-derived artifacts read by this package’s tests. Repository layout is owned
// by project-paths.ts; tests do not import other packages’ generator implementations.
import path from 'node:path'

import { REPOSITORY_ROOT as REPO_ROOT } from './project-paths.js'
export { REPOSITORY_ROOT as REPO_ROOT } from './project-paths.js'

export const REVIEW_RUNS_API_SPEC_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'review-runs-api',
  'v1',
  'openapi.yaml'
)
export const EXECUTION_API_SPEC_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'execution-api',
  'v1',
  'openapi.yaml'
)
