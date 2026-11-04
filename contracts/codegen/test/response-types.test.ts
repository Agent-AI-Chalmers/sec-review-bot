import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

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
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'memory-response-types-')
  )
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
    const file = ts.createSourceFile(
      'types.ts',
      generated,
      ts.ScriptTarget.Latest,
      true
    )
    assert.ok(
      !file.statements.some(
        (node) =>
          ts.isTypeAliasDeclaration(node) &&
          /Status[0-9]+$/.test(node.name.text)
      )
    )
    const aliases = new Map(
      file.statements
        .filter(ts.isTypeAliasDeclaration)
        .map((node) => [node.name.text, node.type])
    )
    for (const [name, expected] of [
      ['WithSuccessResponseBody', ['200', '201', '202', '204']],
      ['WithoutSuccessResponseBody', ['400', '409']],
      ['SingleSuccessResponseBody', ['200']]
    ] as const) {
      const type = aliases.get(name)
      assert.ok(type && ts.isIndexedAccessTypeNode(type))
      const indices = ts.isUnionTypeNode(type.indexType)
        ? type.indexType.types
        : [type.indexType]
      assert.deepEqual(
        indices.map((member) => {
          assert.ok(
            ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
          )
          return member.literal.text
        }),
        expected
      )
    }

    const output = path.join(directory, 'types.ts')
    await writeFile(output, generated + RESPONSE_TYPE_ASSERTIONS)
    const program = ts.createProgram([output], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ESNext
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      ),
      []
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
