// Where the contract-derived artifacts land, for the tests in this package that read them.
//
// These tests do not import a generator tool: each tool lives under its contract family
// (`contracts/<family>/tools`), and a package importing another package's source across
// `rootDir` does not compile. They only need file paths, which follow from the repository
// layout, so the paths are derived here from this file's own location.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const CONTROL_PLANE_API_SPEC_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'control-plane-api',
  'openapi.yaml'
)
export const RUNNER_API_SPEC_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'integration-contract',
  'openapi.json'
)
export const RUNNER_API_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'control-plane',
  'src',
  'runner-api-schema.ts'
)
export const CONTROL_PLANE_API_TYPES_PATH = path.join(
  REPO_ROOT,
  'apps',
  'github-integration',
  'src',
  'control-plane',
  'control-plane-api.ts'
)
