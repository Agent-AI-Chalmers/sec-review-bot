import { readFile } from 'node:fs/promises'

import { memoryStorage } from '@kubb/core'
import { pluginTs, resolverTs } from '@kubb/plugin-ts'
import { createKubb } from 'kubb'
import { parse } from 'yaml'

export { formatGenerated } from './format-generated.js'

// Kubb's default aggregate names (`HealthResponse`, `HealthResponses`) collide with
// contract schema names, so operation aggregates get distinct suffixes.
const bodyName = (operationId: string) => resolverTs.name(`${operationId} ResponseBody`)
const statusMapName = (operationId: string) =>
  resolverTs.name(`${operationId} ResponseBodyByStatus`)
const optionsName = (operationId: string) => resolverTs.name(`${operationId} Options`)

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

interface OpenApiResponse {
  $ref?: string
  content?: Record<string, { schema?: unknown }>
}

interface OpenApiOperation {
  operationId?: string
  responses?: Record<string, OpenApiResponse>
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: { responses?: Record<string, OpenApiResponse> }
}

function resolveResponse(spec: OpenApiDocument, response: OpenApiResponse): OpenApiResponse {
  if (response.$ref === undefined) {
    return response
  }
  const prefix = '#/components/responses/'
  const target = response.$ref.startsWith(prefix)
    ? spec.components?.responses?.[response.$ref.slice(prefix.length)]
    : undefined
  if (target === undefined) {
    throw new Error(`Unsupported response reference: ${response.$ref}`)
  }
  return resolveResponse(spec, target)
}

/** The successful body of one operation: its 2xx statuses that carry a body, plus `void`
 * for 2xx statuses without one. Error statuses never count as a successful body, and an
 * operation without any 2xx status has no successful body to name, so generation fails. */
function successBodyType(spec: OpenApiDocument, operationId: string, operation: OpenApiOperation) {
  const withBody: string[] = []
  let withoutBody = false
  for (const [status, declared] of Object.entries(operation.responses ?? {})) {
    if (/^2xx$/i.test(status)) {
      throw new Error(`${operationId}: status ranges such as ${status} are not supported`)
    }
    if (!/^2\d\d$/.test(status)) {
      continue
    }
    const media = Object.values(resolveResponse(spec, declared).content ?? {})
    if (media.some((entry) => entry.schema === undefined)) {
      // Content without a schema is a body of unknown shape, not an absent body.
      throw new Error(`${operationId} ${status}: response content must declare a schema`)
    }
    if (media.length > 1) {
      // Kubb turns these into `{ contentType; data }` entries, which are not a plain body.
      throw new Error(`${operationId} ${status}: multiple response content types are not supported`)
    }
    if (media.length === 0) {
      withoutBody = true
    } else {
      withBody.push(JSON.stringify(status))
    }
  }
  if (withBody.length === 0 && !withoutBody) {
    throw new Error(`${operationId}: declares no 2xx response`)
  }
  const members = withBody.length ? [`${statusMapName(operationId)}[${withBody.join(' | ')}]`] : []
  if (withoutBody) {
    members.push('void')
  }
  return members.join(' | ')
}

/** Per-operation request options and successful response bodies, keyed by operationId. */
function renderOperationMaps(spec: OpenApiDocument): string {
  const options: string[] = []
  const responses: string[] = []
  for (const [route, pathItem] of Object.entries(spec.paths ?? {})) {
    if ('$ref' in pathItem) {
      // Its operations live elsewhere; skipping them would silently drop map entries.
      throw new Error(`${route}: path item references are not supported`)
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) {
        continue
      }
      const { operationId } = operation
      if (operationId === undefined) {
        throw new Error(`${method.toUpperCase()} operation has no operationId`)
      }
      options.push(`  ${JSON.stringify(operationId)}: ${optionsName(operationId)}`)
      responses.push(
        `  ${JSON.stringify(operationId)}: ${successBodyType(spec, operationId, operation)}`
      )
    }
  }
  return `
/** Request options (path, query, headers, body) of each operation, keyed by operationId. */
export interface OperationOptionsById {
${options.join('\n')}
}

/**
 * Successful response body of each operation, keyed by operationId: the bodies of its 2xx
 * statuses, with \`void\` for a 2xx status that has no body. Error bodies are never included.
 */
export interface OperationResponseById {
${responses.join('\n')}
}
`
}

async function renderKubbTypes(specPath: string): Promise<string> {
  const kubb = createKubb({
    input: specPath,
    output: { path: 'generated' },
    storage: memoryStorage(),
    plugins: [
      pluginTs({
        output: { path: 'types.ts', mode: 'file' },
        // Inline literals preserve discriminated unions; shared enum objects can widen them.
        enum: { type: 'inlineLiteral' },
        resolver: {
          response: {
            responses: (node) => statusMapName(node.operationId),
            response: (node) => bodyName(node.operationId)
          }
        }
      })
    ]
  })
  try {
    const result = await kubb.safeBuild()
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (errors.length) {
      throw new Error(`Kubb generation failed: ${JSON.stringify(errors)}`)
    }
    const outputPath = result.files[0]?.path
    if (outputPath === undefined || result.files.length !== 1) {
      throw new Error(`Kubb generated ${result.files.length} files; expected one`)
    }
    const rendered = await result.storage.readItem(outputPath)
    if (typeof rendered !== 'string') {
      throw new Error(`Kubb did not generate text at ${outputPath}`)
    }
    return rendered
  } finally {
    kubb.dispose()
  }
}

/** The TypeScript projection of an OpenAPI contract: Kubb's declarations, unchanged, followed
 * by the operation maps consumers use. */
export async function renderOpenApiTypes(specPath: string): Promise<string> {
  const spec = parse(await readFile(specPath, 'utf8')) as OpenApiDocument
  // Validate the operations first so unsupported responses fail with a contract-level message.
  const maps = renderOperationMaps(spec)
  return (await renderKubbTypes(specPath)) + maps
}
