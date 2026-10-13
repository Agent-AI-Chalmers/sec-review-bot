// The contract projections must fail loudly on input they cannot represent faithfully.
//
// Both generators translate the hand-written openapi.yaml into a derived artifact, and in
// both cases the dangerous failure is a *silent* one: the output still looks valid while
// describing something the contract does not say. These pin the two shapes that would be
// silently mistranslated, so they fail the build instead.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { OpenAPI3 } from 'openapi-typescript'

import { inlineLocalRefsForTest } from '../scripts/generate-control-plane-schemas.js'
import { errorResponseCodes } from '../scripts/generate-control-plane-types.js'

test('a non-string ErrorResponse.code member fails rather than disappearing', () => {
  // The generated array is advertised as every code the contract allows, and the server
  // refuses to emit anything outside it. Dropping a member would make the server strip a
  // legitimate contract code as if it were internal, so a non-string member is an error.
  const spec = {
    components: { schemas: { ErrorResponse: { properties: { code: { enum: ['VALID', 42] } } } } }
  } as unknown as OpenAPI3

  assert.throws(() => errorResponseCodes(spec), /must contain only strings/)
})

test('string ErrorResponse.code members are returned sorted', () => {
  const spec = {
    components: { schemas: { ErrorResponse: { properties: { code: { enum: ['B', 'A'] } } } } }
  } as unknown as OpenAPI3

  assert.deepEqual(errorResponseCodes(spec), ['A', 'B'])
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

  assert.deepEqual(inlineLocalRefsForTest({ $ref: '#/components/schemas/Target' }, schemas), {
    type: 'string'
  })
  assert.throws(
    () => inlineLocalRefsForTest({ $ref: '#/components/schemas/Missing' }, schemas),
    /dangling \$ref/
  )
})
