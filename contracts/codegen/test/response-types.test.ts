import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { renderOpenApiTypes } from '../src/index.js'

const RESPONSE_TYPE_ASSERTIONS = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
type Success = Assert<Equal<OperationResponseById['withSuccess'], Shared | Other | void>>
type Single = Assert<Equal<OperationResponseById['singleSuccess'], Shared>>
type NoContent = Assert<Equal<OperationResponseById['noContent'], void>>
type Referenced = Assert<Equal<OperationResponseById['referenced'], Shared>>
type Status200 = Assert<Equal<WithSuccessResponseBodyByStatus['200'], Shared>>
type ErrorStatus = Assert<Equal<WithSuccessResponseBodyByStatus['400'], Failure>>
type HealthSchema = Assert<Equal<HealthResponse, { status: 'ok' }>>
type HealthBody = Assert<Equal<OperationResponseById['health'], HealthResponse>>
type Hyphenated = Assert<Equal<OperationResponseById['get-item'], Shared>>
type HyphenatedOptions = Assert<Equal<OperationOptionsById['get-item'], GetItemOptions>>
type Options = Assert<Equal<OperationOptionsById['referenced']['path'], { itemId: string }>>
`

const response = (schema: string) => ({
  description: schema,
  content: {
    'application/json': { schema: { $ref: `#/components/schemas/${schema}` } }
  }
})

const object = (property: string, type: string) => ({
  type: 'object',
  required: [property],
  properties: { [property]: { type } }
})

const components = {
  responses: { SharedResponse: response('Shared') },
  schemas: {
    HealthResponse: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } }
    },
    Shared: { description: '响应 🧭 Shared', ...object('revision', 'integer') },
    Other: object('pending', 'boolean'),
    Failure: object('error', 'string')
  }
}

/** Render a one-off contract with the shared components and the given paths. */
async function render(
  paths: Record<string, unknown>
): Promise<{ directory: string; types: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'contract-response-types-'))
  const spec = path.join(directory, 'openapi.json')
  await writeFile(
    spec,
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Response selection', version: '1' },
      paths,
      components
    })
  )
  try {
    return { directory, types: await renderOpenApiTypes(spec) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('operation maps expose only successful bodies under distinct names', async () => {
  // Compile the consumer-visible types instead of pinning declaration text. Error bodies
  // must never become a success type, and a bodiless 2xx must be void rather than unknown.
  const { directory, types } = await render({
    '/health': {
      get: { operationId: 'health', responses: { '200': response('HealthResponse') } }
    },
    '/success': {
      get: {
        operationId: 'withSuccess',
        responses: {
          '200': response('Shared'),
          '201': response('Shared'),
          '202': response('Other'),
          '204': { description: 'No body' },
          '400': response('Failure')
        }
      }
    },
    '/no-content': {
      delete: {
        operationId: 'noContent',
        responses: { '204': { description: 'Deleted' }, '400': response('Failure') }
      }
    },
    '/items/{itemId}': {
      get: {
        operationId: 'referenced',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { $ref: '#/components/responses/SharedResponse' },
          '404': response('Failure')
        }
      }
    },
    // spectral:oas allows any URL-safe operationId, so map keys must not assume identifiers.
    '/hyphenated': {
      get: { operationId: 'get-item', responses: { '200': response('Shared') } }
    },
    '/single': {
      get: {
        operationId: 'singleSuccess',
        responses: { '200': response('Shared'), '400': response('Failure') }
      }
    }
  })
  try {
    const output = path.join(directory, 'types.ts')
    await writeFile(output, types + RESPONSE_TYPE_ASSERTIONS)
    const require = createRequire(import.meta.url)
    const compiler = path.join(
      path.dirname(require.resolve('typescript/package.json')),
      'bin',
      'tsc'
    )
    execFileSync(
      process.execPath,
      [
        compiler,
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ESNext',
        '--ignoreConfig',
        output
      ],
      { encoding: 'utf8' }
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Each of these would otherwise yield a success type that misstates the contract:
// an error body or void for an operation that never succeeds, void for a body of
// unknown shape, or a content-type envelope instead of a plain body.
test.each([
  {
    name: 'no 2xx response',
    responses: { '400': response('Failure'), default: response('Failure') },
    error: /declares no 2xx response/
  },
  {
    name: '2xx content without a schema',
    responses: { '200': { description: 'Opaque', content: { 'application/json': {} } } },
    error: /must declare a schema/
  },
  {
    name: 'several 2xx content types',
    responses: {
      '200': {
        description: 'Either',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Shared' } },
          'text/plain': { schema: { type: 'string' } }
        }
      }
    },
    error: /multiple response content types/
  },
  {
    name: 'a 2XX status range',
    responses: { '2XX': response('Shared') },
    error: /status ranges/
  },
  {
    name: 'a response reference outside components.responses',
    responses: { '200': { $ref: './shared.yaml#/Shared' } },
    error: /Unsupported response reference/
  }
])('generation rejects $name', async ({ responses, error }) => {
  await expect(render({ '/item': { get: { operationId: 'item', responses } } })).rejects.toThrow(
    error
  )
})

test('generation rejects a path item reference instead of dropping its operations', async () => {
  await expect(render({ '/item': { $ref: './items.yaml#/item' } })).rejects.toThrow(
    /path item references are not supported/
  )
})
