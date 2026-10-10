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
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString, type OpenAPI3 } from 'openapi-typescript'
import prettier from 'prettier'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))

export const CONTROL_PLANE_ROOT = path.resolve(moduleDirectory, '..')
export const SPEC_PATH = path.resolve(
  CONTROL_PLANE_ROOT,
  '..',
  'contracts',
  'integration-contract',
  'openapi.json'
)
export const OUTPUT_PATH = path.join(CONTROL_PLANE_ROOT, 'src', 'runner-api-schema.ts')

const HEADER = `// Generated from ${path.relative(CONTROL_PLANE_ROOT, SPEC_PATH)}. Do not edit.
//
// That document is owned by the agents package and checked there against the service code,
// so this file is a projection of a contract rather than a second copy of one. Regenerate
// it with \`pnpm run generate:runner-api\`.
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(OUTPUT_PATH, await renderRunnerApiTypes())
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`)
}
