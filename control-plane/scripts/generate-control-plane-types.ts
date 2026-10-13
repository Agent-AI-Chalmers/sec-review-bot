// Project the Control Plane's OpenAPI document into TypeScript for github-integration.
//
// The document is the hand-written single source of truth (contracts/control-plane-api/
// openapi.yaml); this module only produces its TypeScript view, so the client derives its
// types from the contract rather than a hand-authored copy.
//
// Mirrors `generate-runner-api-types.ts`: the generator and the stale-check test both
// call `renderControlPlaneApiTypes`, so they cannot disagree about what "current" means.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString, type OpenAPI3 } from 'openapi-typescript'
import prettier from 'prettier'
import { parse as parseYaml } from 'yaml'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))

export const CONTROL_PLANE_ROOT = path.resolve(moduleDirectory, '..')
export const SPEC_PATH = path.resolve(
  CONTROL_PLANE_ROOT,
  '..',
  'contracts',
  'control-plane-api',
  'openapi.yaml'
)
export const OUTPUT_PATH = path.resolve(
  CONTROL_PLANE_ROOT,
  '..',
  'apps',
  'github-integration',
  'src',
  'control-plane',
  'control-plane-api.ts'
)

const HEADER = `// Generated from ${path.relative(CONTROL_PLANE_ROOT, SPEC_PATH)}. Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with \`pnpm run generate:control-plane-types\`.
`

/** The committed content of the github-integration control-plane API types. */
export async function renderControlPlaneApiTypes(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenAPI3
  const rendered = HEADER + astToString(await openapiTS(spec))
  const options = await prettier.resolveConfig(OUTPUT_PATH)
  return await prettier.format(rendered, { ...options, filepath: OUTPUT_PATH })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(OUTPUT_PATH, await renderControlPlaneApiTypes())
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`)
}
