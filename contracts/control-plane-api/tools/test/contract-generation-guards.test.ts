// The contract projections must fail loudly on input they cannot represent faithfully.
//
// The generators translate the hand-written openapi.yaml into a derived artifact, and in
// each case the dangerous failure is a *silent* one: the output still looks valid while
// describing something the contract does not say. These pin the shapes that would be
// silently mistranslated, so they fail the build instead.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { OpenAPI3 } from 'openapi-typescript'

import { inlineLocalRefsForTest } from '../src/generate-schemas.js'
import {
  errorResponseCodes,
  listRunQueryParameters
} from '../src/generate-types.js'

test('a non-string ErrorResponse.code member fails rather than disappearing', () => {
  // The generated array is advertised as every code the contract allows, and the server
  // refuses to emit anything outside it. Dropping a member would make the server strip a
  // legitimate contract code as if it were internal, so a non-string member is an error.
  const spec = {
    components: {
      schemas: {
        ErrorResponse: { properties: { code: { enum: ['VALID', 42] } } }
      }
    }
  } as unknown as OpenAPI3

  assert.throws(() => errorResponseCodes(spec), /must contain only strings/)
})

test('string ErrorResponse.code members are returned sorted', () => {
  const spec = {
    components: {
      schemas: { ErrorResponse: { properties: { code: { enum: ['B', 'A'] } } } }
    }
  } as unknown as OpenAPI3

  assert.deepStrictEqual(errorResponseCodes(spec), ['A', 'B'])
})

test('a $ref with sibling keywords fails rather than dropping the siblings', () => {
  // The inliner replaces a local $ref with its target. A sibling keyword written beside the
  // $ref (description, nullable, default, …) would vanish from the committed schema, so the
  // generator rejects it instead of emitting a schema that says less than the contract.
  const schemas = { Target: { type: 'string' } }

  assert.throws(
    () =>
      inlineLocalRefsForTest(
        { $ref: '#/components/schemas/Target', description: 'kept?' },
        schemas
      ),
    /\$ref .* has sibling keywords \(description\)/
  )
})

test('a bare local $ref is inlined, and a dangling one fails', () => {
  const schemas = { Target: { type: 'string' } }

  assert.deepStrictEqual(
    inlineLocalRefsForTest({ $ref: '#/components/schemas/Target' }, schemas),
    {
      type: 'string'
    }
  )
  assert.throws(
    () =>
      inlineLocalRefsForTest({ $ref: '#/components/schemas/Missing' }, schemas),
    /dangling \$ref/
  )
})

/** The `listRuns` query parameter the projection reads: one form-exploded object whose
 * properties are the filter names. */
function listRunsSpec(queryObject: Record<string, unknown>): OpenAPI3 {
  return {
    paths: {
      '/v1/runs': {
        get: {
          parameters: [
            {
              in: 'query',
              name: 'filter',
              style: 'form',
              explode: true,
              schema: queryObject
            }
          ]
        }
      }
    }
  } as unknown as OpenAPI3
}

test('the declared form-exploded query object projects to its property names', () => {
  const spec = listRunsSpec({
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'integer' }, workflow: { type: 'string' } }
  })

  assert.deepStrictEqual(listRunQueryParameters(spec), ['limit', 'workflow'])
})

test('dropping additionalProperties: false fails rather than silently relaxing the query', () => {
  // The property names are unchanged, so the projection would look identical — but an
  // undeclared query parameter would stop being a 400 and become a silently ignored one.
  // The guard has to catch that, because the output alone cannot show it.
  const spec = listRunsSpec({
    type: 'object',
    properties: { limit: { type: 'integer' } }
  })

  assert.throws(
    () => listRunQueryParameters(spec),
    /additionalProperties: false on its query object/
  )
})

test('a conventional per-parameter list fails rather than projecting nothing', () => {
  const spec = {
    paths: {
      '/v1/runs': {
        get: {
          parameters: [
            { in: 'query', name: 'limit', schema: { type: 'integer' } }
          ]
        }
      }
    }
  } as unknown as OpenAPI3

  assert.throws(
    () => listRunQueryParameters(spec),
    /not the expected form-exploded object/
  )
})
