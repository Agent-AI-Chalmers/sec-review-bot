import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { parseSync, type TSTypeAliasDeclaration } from 'oxc-parser'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { renderOpenApiTypes } from '../src/index.js'

const RESPONSE_TYPE_ASSERTIONS = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
type Success = Assert<Equal<WithSuccessResponseBody, Shared | Other | WithSuccessResponseBodyByStatus['204']>>
type Errors = Assert<Equal<WithoutSuccessResponseBody, Failure>>
type Single = Assert<Equal<SingleSuccessResponseBody, Shared>>
type Status200 = Assert<Equal<WithSuccessResponseBodyByStatus['200'], Shared>>
type Status201 = Assert<Equal<WithSuccessResponseBodyByStatus['201'], Shared>>
type ErrorStatus = Assert<Equal<WithSuccessResponseBodyByStatus['400'], Failure>>
type HealthSchema = Assert<Equal<HealthResponse, { status: 'ok' }>>
type HealthStatus = Assert<Equal<HealthResponseBodyByStatus['200'], HealthResponse>>
`

test('response indexing preserves Kubb success selection and error-only fallback', async () => {
  // Distinct status aliases can share a body. Keep the status map and select exactly
  // Kubb's original members, rather than including every response (especially errors).
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-response-types-'))
  const response = (schema: string) => ({
    description: schema,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${schema}` } }
    }
  })
  try {
    const spec = path.join(directory, 'openapi.json')
    await writeFile(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Response selection', version: '1' },
        paths: {
          '/health': {
            get: {
              operationId: 'health',
              responses: { '200': response('HealthResponse') }
            }
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
          '/errors': {
            get: {
              operationId: 'withoutSuccess',
              responses: {
                '400': response('Failure'),
                '409': response('Failure')
              }
            }
          },
          '/single': {
            get: {
              operationId: 'singleSuccess',
              responses: {
                '200': response('Shared'),
                '400': response('Failure')
              }
            }
          }
        },
        components: {
          schemas: {
            HealthResponse: {
              type: 'object',
              required: ['status'],
              properties: { status: { type: 'string', enum: ['ok'] } }
            },
            Shared: {
              description: '响应 🧭 Shared',
              type: 'object',
              required: ['revision'],
              properties: { revision: { type: 'integer' } }
            },
            Other: {
              type: 'object',
              required: ['pending'],
              properties: { pending: { type: 'boolean' } }
            },
            Failure: {
              type: 'object',
              required: ['error'],
              properties: { error: { type: 'string' } }
            }
          }
        }
      })
    )
    const generated = await renderOpenApiTypes(spec)
    expect(generated).toContain('响应 🧭 Shared')
    const { program, errors } = parseSync('types.ts', generated)
    expect(errors).toStrictEqual([])
    const declarations = program.body
      .map((node) => (node.type === 'ExportNamedDeclaration' ? node.declaration : node))
      .filter((node): node is TSTypeAliasDeclaration => node?.type === 'TSTypeAliasDeclaration')
    expect(declarations.some((node) => /Status[0-9]+$/.test(node.id.name))).toBe(false)
    const aliases = new Map(declarations.map((node) => [node.id.name, node.typeAnnotation]))
    for (const [name, expected] of [
      ['WithSuccessResponseBody', ['200', '201', '202', '204']],
      ['WithoutSuccessResponseBody', ['400', '409']],
      ['SingleSuccessResponseBody', ['200']]
    ] as const) {
      const type = aliases.get(name)
      expect.assert(type?.type === 'TSIndexedAccessType')
      const indices =
        type.indexType.type === 'TSUnionType' ? type.indexType.types : [type.indexType]
      expect(
        indices.map((member) => {
          expect.assert(
            member.type === 'TSLiteralType' &&
              member.literal.type === 'Literal' &&
              typeof member.literal.value === 'string'
          )
          return member.literal.value
        })
      ).toStrictEqual(expected)
    }

    const output = path.join(directory, 'types.ts')
    await writeFile(output, generated + RESPONSE_TYPE_ASSERTIONS)
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
