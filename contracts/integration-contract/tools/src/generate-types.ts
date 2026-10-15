// Project the runner's OpenAPI document into TypeScript.
//
// The document itself is owned by the `agents` package, where a test keeps it identical to
// the service code. This module only produces its TypeScript view, so that the control
// plane stops restating the runner's shapes by hand.
//
// The generator and the test that fails when the committed file lags both call
// `renderRunnerApiTypes`, so they cannot disagree about what "current" means.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import openapiTS, { astToString, type OpenAPI3 } from 'openapi-typescript'
import prettier from 'prettier'

import type { GeneratedArtifact } from './generated-artifact.js'
import { REPO_ROOT } from './repo-root.js'

export { REPO_ROOT }
export const CONTROL_PLANE_ROOT = path.join(REPO_ROOT, 'control-plane')
export const SPEC_PATH = path.resolve(
  REPO_ROOT,
  'contracts',
  'integration-contract',
  'openapi.json'
)
export const OUTPUT_PATH = path.join(
  CONTROL_PLANE_ROOT,
  'src',
  'runner-api-schema.ts'
)

const HEADER = `// Generated from ${path.relative(REPO_ROOT, SPEC_PATH)} (path relative to the repository root). Do not edit.
//
// That document is owned by the agents package and checked there against the service code,
// so this file is a projection of a contract rather than a second copy of one. Regenerate
// it with \`pnpm --dir contracts/integration-contract/tools run generate\`.
`

/** The committed content of `src/runner-api-schema.ts`. */
export async function renderRunnerApiTypes(): Promise<string> {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as OpenAPI3
  const rendered = HEADER + astToString(await openapiTS(spec))
  // `format` does not read the project's Prettier config from `filepath`; it has to be
  // resolved and passed, or the output keeps the generator's own quoting and fails
  // `format:check`.
  const options = await prettier.resolveConfig(OUTPUT_PATH)
  return await prettier.format(rendered, { ...options, filepath: OUTPUT_PATH })
}

/** This generator's outputs as the shared descriptor the checker walks. */
export function generatedArtifacts(): GeneratedArtifact[] {
  return [{ output: OUTPUT_PATH, render: renderRunnerApiTypes }]
}
