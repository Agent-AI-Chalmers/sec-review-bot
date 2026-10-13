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

// The server's own projection of the contract's error-code vocabulary. The hand-written
// openapi.yaml owns the strings; this file exposes them as a closed union plus an ordered
// array so `errors.ts` can keep its semantic keys while its string values are pinned to the
// contract (and vice-versa) by a compile-time check.
export const ERROR_CODES_PATH = path.resolve(CONTROL_PLANE_ROOT, 'src', 'error-codes-generated.ts')

/** Pull the `PUBLICATION_STEP_*` members out of the contract's ErrorResponse.code enum. */
export function publicationStepCodes(spec: OpenAPI3): string[] {
  const codeSchema = spec.components?.schemas?.ErrorResponse as
    { properties?: { code?: { enum?: (string | number)[] } } } | undefined
  const values = codeSchema?.properties?.code?.enum ?? []
  return values
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => value.startsWith('PUBLICATION_STEP_'))
    .sort()
}

/** The committed content of `control-plane/src/error-codes-generated.ts`. */
export async function renderErrorCodeTypes(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenAPI3
  const codes = publicationStepCodes(spec)
  const union = codes.map((code) => `  | '${code}'`).join('\n')
  const array = codes.map((code) => `  '${code}',`).join('\n')
  const body = `// Generated from ${path.relative(CONTROL_PLANE_ROOT, SPEC_PATH)}. Do not edit.
//
// The hand-written openapi.yaml owns the publication-step error-code vocabulary; this file
// is its server-side projection. Regenerate it with \`pnpm run generate:control-plane-types\`.

export type PublicationStepErrorCode =\n${union}

export const PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT = [\n${array}\n] as const satisfies readonly PublicationStepErrorCode[]
`
  const options = await prettier.resolveConfig(ERROR_CODES_PATH)
  return await prettier.format(body, { ...options, filepath: ERROR_CODES_PATH })
}

// The server's projection of the contract's domain shapes. The hand-written openapi.yaml owns
// the shapes; this file re-exports them under the names the server already uses, so the server
// derives its types from the contract instead of a parallel hand-written TypeBox schema.
export const CONTRACT_TYPES_PATH = path.resolve(
  CONTROL_PLANE_ROOT,
  'src',
  'contract-types-generated.ts'
)

const SHAPE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['ReviewRunRecord', 'ReviewRunRecord'],
  ['ReviewRunAdmission', 'ReviewRunAdmission'],
  ['PublicationWork', 'PublicationWork'],
  ['PublicationStepRecord', 'PublicationStepRecord'],
  ['ObservedStep', 'ObservedPublicationStep'],
  ['ObservedRun', 'ObservedRun']
]

/** The committed content of `control-plane/src/contract-types-generated.ts`. */
export async function renderContractTypes(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenAPI3
  // Ask openapi-typescript for the full document, then keep only the `components` interface
  // (the server only needs the domain shapes, not the paths).
  const ast = await openapiTS(spec)
  const components = astToString(ast).match(/export interface components \{[\s\S]*?\n\}\n/)?.[0]
  if (components === undefined) {
    throw new Error('openapi-typescript produced no components interface')
  }
  const lines = SHAPE_ALIASES.map(
    ([alias, schema]) => `export type ${alias} = components['schemas']['${schema}']`
  )
  const body = `// Generated from ${path.relative(CONTROL_PLANE_ROOT, SPEC_PATH)}. Do not edit.
//
// The hand-written openapi.yaml owns the domain shapes; these aliases are its server-side
// projection, so the server's types follow the contract instead of a parallel schema.
// Regenerate it with \`pnpm run generate:control-plane-types\`.

${components}

${lines.join('\n')}
`
  const options = await prettier.resolveConfig(CONTRACT_TYPES_PATH)
  return await prettier.format(body, { ...options, filepath: CONTRACT_TYPES_PATH })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(OUTPUT_PATH, await renderControlPlaneApiTypes())
  writeFileSync(ERROR_CODES_PATH, await renderErrorCodeTypes())
  writeFileSync(CONTRACT_TYPES_PATH, await renderContractTypes())
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`)
  console.log(`Wrote ${path.relative(process.cwd(), ERROR_CODES_PATH)}`)
  console.log(`Wrote ${path.relative(process.cwd(), CONTRACT_TYPES_PATH)}`)
}
