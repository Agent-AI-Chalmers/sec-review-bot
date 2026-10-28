// Where the contract-derived artifacts land, for the tests in this package that read them.
//
// These tests do not import a generator tool: each tool lives under its contract family
// (`contracts/<family>/tools`), and a package importing another package's source across
// `rootDir` does not compile. They only need file paths, which follow from the repository
// layout, so the paths are derived here from this file's own location.
import path from 'node:path'

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

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
export const EXECUTION_API_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'review-runs',
  'src',
  'execution-api-schema.ts'
)
export const REVIEW_RUNS_API_TYPES_PATH = path.join(
  REPO_ROOT,
  'apps',
  'github-integration',
  'src',
  'review-runs',
  'review-runs-api.ts'
)
