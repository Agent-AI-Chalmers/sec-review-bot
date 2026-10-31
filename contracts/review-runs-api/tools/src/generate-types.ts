// Project Review Runs' OpenAPI document into TypeScript for github-integration.
//
// The document is the hand-written single source of truth
// (`contracts/review-runs-api/v1/openapi.yaml`); this module only produces its TypeScript view, so the client derives its
// types from the contract rather than a hand-authored copy.
//
// Mirrors the execution-api family's generator
// (`contracts/execution-api/tools/src/generate-types.ts`): the generator and the
// stale-check test both call `renderReviewRunsApiTypes`, so they cannot disagree about what
// "current" means.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import prettier from 'prettier'
import { parse as parseYaml } from 'yaml'

import type { GeneratedArtifact } from './generated-artifact.js'
import { renderKubbTypes } from './render-kubb-types.js'
import { REPO_ROOT } from './repo-root.js'

export { REPO_ROOT }
export const REVIEW_RUNS_ROOT = path.join(REPO_ROOT, 'services', 'review-runs')
export const SPEC_PATH = path.resolve(
  REPO_ROOT,
  'contracts',
  'review-runs-api',
  'v1',
  'openapi.yaml'
)
export const OUTPUT_PATH = path.resolve(
  REPO_ROOT,
  'apps',
  'github-integration',
  'src',
  'review-runs',
  'review-runs-api.ts'
)

/** The "do not edit" header every generated file carries. The source path is relative to the
 * repository root and the header says so, because the projection may live in another package
 * and a bare relative path would be read (wrongly) as relative to the file itself. */
function headerComment(): string {
  const source = path.relative(REPO_ROOT, SPEC_PATH)
  return `// Generated from ${source} (path relative to the repository root). Do not edit.
//
// That document is the hand-written contract; this file is a projection of it, not a second
// copy. Regenerate it with \`pnpm --dir contracts/review-runs-api/tools run generate\`.
`
}

const HEADER = headerComment()

type OpenApiPathItem = Record<string, unknown>

export interface OpenApiDocument {
  paths?: Record<string, OpenApiPathItem>
  components?: { schemas?: Record<string, unknown> }
}

/** Every `(operationId, path, method)` the contract declares, in document order. The
 * operationId is what the client is keyed by, and the path/method are the URL it must be
 * called at — the pairing the generated types alone cannot express, because two operations
 * with identical shapes (both taking `{ token }` and returning a boolean, say) are
 * indistinguishable structurally. */
export function operationRoutes(
  spec: OpenApiDocument
): Array<{ operationId: string; path: string; method: string }> {
  const methods = [
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace'
  ]
  const paths = (spec.paths ?? {}) as Record<string, OpenApiPathItem>
  const routes: Array<{ operationId: string; path: string; method: string }> =
    []
  for (const [path, item] of Object.entries(paths)) {
    for (const method of methods) {
      const operation = item[method] as { operationId?: string } | undefined
      if (operation?.operationId !== undefined) {
        routes.push({ operationId: operation.operationId, path, method })
      }
    }
  }
  return routes
}

/** The runtime `operationRoutes` map projected into the generated file. It is data, not a
 * type, because the client needs the actual strings at request time; deriving them from the
 * `paths` type is impossible when operations are structurally identical. */
function renderOperationRoutes(spec: OpenApiDocument): string {
  const entries = operationRoutes(spec)
    .map(
      ({ operationId, path, method }) =>
        `  ${operationId}: { path: '${path}', method: '${method}' }`
    )
    .join(',\n')
  return `/** Each operation's contract path and HTTP method, keyed by \`operationId\` and taken from
 * the document itself. The client builds every request from this map, so an operation cannot
 * be sent to another operation's URL or with another operation's method: the call site names
 * the operation, and the URL is looked up, never passed in. */
export const operationRoutes = {
${entries}
} as const
`
}

function operationTypeName(operationId: string): string {
  return operationId.charAt(0).toUpperCase() + operationId.slice(1)
}

function renderOperationTypeMaps(spec: OpenApiDocument): string {
  const routes = operationRoutes(spec)
  const options = routes
    .map(({ operationId }) => {
      const name = operationTypeName(operationId)
      return `  ${operationId}: ${name}Options`
    })
    .join('\n')
  const responses = routes
    .map(({ operationId }) => {
      const name = operationTypeName(operationId)
      return `  ${operationId}: ${name}Response`
    })
    .join('\n')
  return `export interface OperationOptionsById {
${options}
}

export interface OperationResponseById {
${responses}
}
`
}

/** The committed content of the github-integration review-runs API types. */
export async function renderReviewRunsApiTypes(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument
  const rendered =
    HEADER +
    (await renderKubbTypes(SPEC_PATH)) +
    '\n' +
    renderOperationRoutes(spec) +
    '\n' +
    renderOperationTypeMaps(spec)
  const options = await prettier.resolveConfig(OUTPUT_PATH)
  return await prettier.format(rendered, { ...options, filepath: OUTPUT_PATH })
}

// The server's own projection of the contract's error-code vocabulary. The hand-written
// openapi.yaml owns the strings; this file exposes them as a closed union plus an ordered
// array so `errors.ts` can keep its semantic keys while its string values are pinned to the
// contract (and vice-versa) by a compile-time check.
export const ERROR_CODES_PATH = path.resolve(
  REVIEW_RUNS_ROOT,
  'src',
  'error-codes-generated.ts'
)

/** Every member of the contract's ErrorResponse.code enum.
 *
 * A non-string member is an error rather than something to filter out: the generated file
 * advertises itself as "Every code the contract's ErrorResponse.code enum allows", and that
 * array is a security control — `server.ts` refuses to emit any code outside it, so a member
 * silently dropped here would be stripped from a response as if it were an internal code. */
export function errorResponseCodes(spec: OpenApiDocument): string[] {
  const codeSchema = spec.components?.schemas?.ErrorResponse as
    { properties?: { code?: { enum?: (string | number)[] } } } | undefined
  const values = codeSchema?.properties?.code?.enum ?? []
  const nonString = values.filter((value) => typeof value !== 'string')
  if (nonString.length > 0) {
    throw new Error(
      `ErrorResponse.code must contain only strings; found ${JSON.stringify(nonString)}.`
    )
  }
  return (values as string[]).sort()
}

/** Pull the `PUBLICATION_STEP_*` members out of the contract's ErrorResponse.code enum. */
export function publicationStepCodes(spec: OpenApiDocument): string[] {
  return errorResponseCodes(spec).filter((value) =>
    value.startsWith('PUBLICATION_STEP_')
  )
}

/** The committed content of `services/review-runs/src/error-codes-generated.ts`. */
export async function renderErrorCodeTypes(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument
  const codes = publicationStepCodes(spec)
  const union = codes.map((code) => `  | '${code}'`).join('\n')
  const array = codes.map((code) => `  '${code}',`).join('\n')
  const all = errorResponseCodes(spec)
    .map((code) => `  '${code}',`)
    .join('\n')
  const body =
    headerComment() +
    `//
// The hand-written openapi.yaml owns the error-code vocabulary; this file is its server-side
// projection.

export type PublicationStepErrorCode =\n${union}

export const PUBLICATION_STEP_ERROR_CODES_FROM_CONTRACT = [\n${array}\n] as const satisfies readonly PublicationStepErrorCode[]

/** Every code the contract's ErrorResponse.code enum allows. */
export const ERROR_RESPONSE_CODES_FROM_CONTRACT = [\n${all}\n] as const
`
  const options = await prettier.resolveConfig(ERROR_CODES_PATH)
  return await prettier.format(body, { ...options, filepath: ERROR_CODES_PATH })
}

// The server's projection of the contract's domain shapes. The hand-written openapi.yaml owns
// the shapes; this file re-exports them under the names the server already uses, so the server
// derives its types from the contract instead of a parallel hand-written TypeBox schema.
export const CONTRACT_TYPES_PATH = path.resolve(
  REVIEW_RUNS_ROOT,
  'src',
  'contract-types-generated.ts'
)

/** The committed content of `services/review-runs/src/contract-types-generated.ts`. */
export async function renderContractTypes(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument
  const body =
    headerComment() +
    `//
// The hand-written openapi.yaml owns the domain shapes and the request shapes; these
// types are its server-side projection, so the server's types follow the contract
// instead of a parallel schema.

${await renderKubbTypes(SPEC_PATH)}

${renderOperationTypeMaps(spec)}

export type ObservedStep = ObservedPublicationStep
`
  const options = await prettier.resolveConfig(CONTRACT_TYPES_PATH)
  return await prettier.format(body, {
    ...options,
    filepath: CONTRACT_TYPES_PATH
  })
}

// The console's projection of the parameters `listRuns` accepts. The document models the
// list filters as one `form`-exploded object, so its declared property names are the query
// parameters. The BFF and the browser both forward/request only these, and were keeping
// their own copy of the list; deriving it here removes that third hand-kept description.
export const LIST_RUN_QUERY_PARAMS_PATH = path.resolve(
  REPO_ROOT,
  'apps',
  'control-plane-ui',
  'shared',
  'list-run-query-params.ts'
)

/** The parameter names `listRuns` declares.
 *
 * The contract carries them as the properties of one exploded query object (attaching
 * `additionalProperties: false` there is what makes an undeclared parameter a 400), so this
 * reads that object's property names. An operation with no such object is an error rather
 * than an empty list: an empty allow-list would make the console send no filters at all,
 * which is a silent loss of function, not a change to an empty set. */
export function listRunQueryParameters(spec: OpenApiDocument): string[] {
  const list = (
    spec.paths?.['/v1/runs'] as { get?: { parameters?: unknown[] } } | undefined
  )?.get
  const parameters = list?.parameters
  if (!Array.isArray(parameters)) {
    throw new Error("openapi.yaml's listRuns has no parameters to project.")
  }
  for (const parameter of parameters) {
    const candidate = parameter as {
      in?: string
      style?: string
      explode?: boolean
      schema?: {
        type?: string
        properties?: Record<string, unknown>
        additionalProperties?: unknown
      }
    }
    if (candidate.in !== 'query') continue
    if (
      candidate.style !== 'form' ||
      candidate.explode !== true ||
      candidate.schema?.type !== 'object' ||
      candidate.schema.properties === undefined
    ) {
      throw new Error(
        'listRuns query parameters are not the expected form-exploded object; ' +
          'update the projection or the contract.'
      )
    }
    // The strictness is the whole point of the object form: `additionalProperties: false`
    // is what makes an undeclared query parameter a 400 instead of a silently ignored one.
    // A conventional per-parameter list cannot express it, but neither can the object form
    // alone — dropping just this keyword would leave the projection unchanged (same property
    // names) while the surface quietly accepted anything, so it is asserted here too.
    if (candidate.schema.additionalProperties !== false) {
      throw new Error(
        'listRuns must declare additionalProperties: false on its query object, or an ' +
          'undeclared query parameter stops being rejected; update the contract.'
      )
    }
    return Object.keys(candidate.schema.properties)
  }
  throw new Error(
    "openapi.yaml's listRuns declares no query parameters to project."
  )
}

/** The committed content of `apps/control-plane-ui/shared/list-run-query-params.ts`. */
export async function renderListRunQueryParams(): Promise<string> {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument
  const names = listRunQueryParameters(spec)
  const entries = names.map((name) => `  '${name}',`).join('\n')
  const body =
    headerComment() +
    `//
// The contract's \`listRuns\` operation declares these query parameters (as one form-exploded
// object). The console builds each request, and the BFF proxies it, from this one list, so
// neither can send a parameter the contract does not accept.

/** The query parameter names \`listRuns\` declares, in document order. */
export const LIST_RUN_QUERY_PARAMS = [
${entries}
] as const
`
  const options = await prettier.resolveConfig(LIST_RUN_QUERY_PARAMS_PATH)
  return await prettier.format(body, {
    ...options,
    filepath: LIST_RUN_QUERY_PARAMS_PATH
  })
}

/** The console reads Review Runs through the BFF, so it needs the same response shapes
 * the server produces - above all `ArtifactStorage`, whose contract is a discriminated union
 * (`available` requires `artifact`; the other two forbid it). A hand-written copy flattened
 * that union, which let the console type-check code that reads a missing artifact. This
 * projects the shapes the console imports from one generated file instead. */
export const UI_TYPES_PATH = path.resolve(
  REPO_ROOT,
  'apps',
  'control-plane-ui',
  'browser',
  'features',
  'runs',
  'api-types.generated.ts'
)

/** The committed content of `apps/control-plane-ui/browser/features/runs/api-types.generated.ts`. */
export async function renderUiContractTypes(): Promise<string> {
  const body =
    headerComment() +
    `//
// The shapes the console reads. The console has no access to the server's source, so it imports
// these aliases rather than restating the contract: a hand-written copy would drift silently,
// and a flattened copy of a discriminated union (ArtifactStorage) cannot express which fields a
// given status requires.

${await renderKubbTypes(SPEC_PATH)}

export type Run = ObservedRun
export type RunEvent = ReviewRunEvent
export type PublicationStep = ObservedPublicationStep
`
  const options = await prettier.resolveConfig(UI_TYPES_PATH)
  return await prettier.format(body, { ...options, filepath: UI_TYPES_PATH })
}

/** This generator's outputs as the shared descriptor the checker walks. */
export function generatedArtifacts(): GeneratedArtifact[] {
  return [
    { output: OUTPUT_PATH, render: renderReviewRunsApiTypes },
    { output: ERROR_CODES_PATH, render: renderErrorCodeTypes },
    { output: CONTRACT_TYPES_PATH, render: renderContractTypes },
    { output: LIST_RUN_QUERY_PARAMS_PATH, render: renderListRunQueryParams },
    { output: UI_TYPES_PATH, render: renderUiContractTypes }
  ]
}
