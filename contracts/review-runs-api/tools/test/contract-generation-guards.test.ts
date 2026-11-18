// The contract projections must fail loudly on input they cannot represent faithfully.
//
// The generators translate the hand-written openapi.yaml into a derived artifact, and in
// each case the dangerous failure is a *silent* one: the output still looks valid while
// describing something the contract does not say. These pin the shapes that would be
// silently mistranslated, so they fail the build instead.
import { expect, test } from 'vitest'

import { inlineLocalRefsForTest } from '../src/generate-schemas.js'
import { applyTextOverlay } from '../src/generate-state-machines.js'
import {
  errorResponseCodes,
  listRunQueryParameters,
  type OpenApiDocument
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
  } as unknown as OpenApiDocument

  expect(() => errorResponseCodes(spec)).toThrow(/must contain only strings/)
})

test('string ErrorResponse.code members are returned sorted', () => {
  const spec = {
    components: {
      schemas: { ErrorResponse: { properties: { code: { enum: ['B', 'A'] } } } }
    }
  } as unknown as OpenApiDocument

  expect(errorResponseCodes(spec)).toStrictEqual(['A', 'B'])
})

test('a $ref with sibling keywords fails rather than dropping the siblings', () => {
  // The inliner replaces a local $ref with its target. A sibling keyword written beside the
  // $ref (description, nullable, default, …) would vanish from the committed schema, so the
  // generator rejects it instead of emitting a schema that says less than the contract.
  const schemas = { Target: { type: 'string' } }

  expect(() =>
    inlineLocalRefsForTest(
      { $ref: '#/components/schemas/Target', description: 'kept?' },
      schemas
    )
  ).toThrow(/\$ref .* has sibling keywords \(description\)/)
})

test('a bare local $ref is inlined, and a dangling one fails', () => {
  const schemas = { Target: { type: 'string' } }

  expect(
    inlineLocalRefsForTest({ $ref: '#/components/schemas/Target' }, schemas)
  ).toStrictEqual({
    type: 'string'
  })
  expect(() =>
    inlineLocalRefsForTest({ $ref: '#/components/schemas/Missing' }, schemas)
  ).toThrow(/dangling \$ref/)
})

/** The `listRuns` query parameter the projection reads: one form-exploded object whose
 * properties are the filter names. */
function listRunsSpec(queryObject: Record<string, unknown>): OpenApiDocument {
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
  }
}

test('the declared form-exploded query object projects to its property names', () => {
  const spec = listRunsSpec({
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'integer' }, workflow: { type: 'string' } }
  })

  expect(listRunQueryParameters(spec)).toStrictEqual(['limit', 'workflow'])
})

test('dropping additionalProperties: false fails rather than silently relaxing the query', () => {
  // The property names are unchanged, so the projection would look identical — but an
  // undeclared query parameter would stop being a 400 and become a silently ignored one.
  // The guard has to catch that, because the output alone cannot show it.
  const spec = listRunsSpec({
    type: 'object',
    properties: { limit: { type: 'integer' } }
  })

  expect(() => listRunQueryParameters(spec)).toThrow(
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
  } as unknown as OpenApiDocument

  expect(() => listRunQueryParameters(spec)).toThrow(
    /not the expected form-exploded object/
  )
})

// The Chinese overlay may only translate text. Each guard below stands for a way a stale or
// careless overlay would otherwise ship a console that silently disagrees with the contract.
function overlayBlock(): Record<string, unknown> {
  const machine = () => ({
    title: 'Machine',
    states: { a: { label: 'A', summary: 'Brief a.', description: 'State a.' } },
    transitions: [
      { from: 'a', to: 'a', label: 'given up', reason: 'GIVEN_UP' },
      { from: 'a', to: 'a', label: 'resumed', reason: 'RESUMED' }
    ]
  })
  return {
    preparation: machine(),
    execution: machine(),
    publication: machine()
  }
}

function fullOverlay(): { target: string; update: Record<string, string> }[] {
  return ['preparation', 'execution', 'publication'].flatMap((axis) => [
    { target: `$['x-state-machines'].${axis}`, update: { title: '机' } },
    {
      target: `$['x-state-machines'].${axis}.states.a`,
      update: { label: '甲', summary: '甲概述。', description: '状态甲。' }
    },
    ...['GIVEN_UP', 'RESUMED'].map((reason) => ({
      target: `$['x-state-machines'].${axis}.transitions[?@.from=='a' && @.to=='a' && @.reason=='${reason}']`,
      update: { label: reason === 'GIVEN_UP' ? '放弃' : '恢复' }
    }))
  ])
}

function apply(actions: unknown[]): Record<string, unknown> {
  const block = overlayBlock()
  applyTextOverlay(block, { overlay: '1.0.0', actions }, 'zh.yaml')
  return block
}

test('a complete text overlay replaces only text', () => {
  const block = apply(fullOverlay())
  expect(block.preparation).toStrictEqual({
    title: '机',
    states: {
      a: { label: '甲', summary: '甲概述。', description: '状态甲。' }
    },
    transitions: [
      { from: 'a', to: 'a', label: '放弃', reason: 'GIVEN_UP' },
      { from: 'a', to: 'a', label: '恢复', reason: 'RESUMED' }
    ]
  })
})

test('an overlay target that no longer matches the contract fails', () => {
  const actions = fullOverlay()
  actions[1]!.target = "$['x-state-machines'].preparation.states.removed"
  expect(() => apply(actions)).toThrow(/matches no node/)
})

test('two overlay actions on one node fail', () => {
  const actions = fullOverlay()
  actions.push({ ...actions[0]! })
  expect(() => apply(actions)).toThrow(/more than one action/)
})

test('an overlay that changes contract structure fails', () => {
  const actions = fullOverlay()
  actions[2]!.update = { label: '放弃', reason: 'OTHER' }
  expect(() => apply(actions)).toThrow(/may only replace .* not reason/)
})

test('an overlay that adds a text field the contract lacks fails', () => {
  const actions = fullOverlay()
  actions[0]!.update = { title: '机', description: '多余' }
  expect(() => apply(actions)).toThrow(/not description/)
})

test('empty translated text fails', () => {
  const actions = fullOverlay()
  actions[0]!.update = { title: ' ' }
  expect(() => apply(actions)).toThrow(/must be non-empty text/)
})

test('text left untranslated fails', () => {
  expect(() => apply(fullOverlay().slice(1))).toThrow(
    /has no title translation/
  )
})

test('a node translated only in part fails', () => {
  const actions = fullOverlay()
  delete actions[1]!.update.description
  expect(() => apply(actions)).toThrow(/has no description translation/)
})

test('a transition target that matches several transitions fails', () => {
  // Without a reason, the target must mean the transition that has none; it never picks one of
  // several reason-specific transitions by position.
  const block = overlayBlock()
  ;(block.preparation as { transitions: object[] }).transitions.push(
    { from: 'a', to: 'a', label: 'x' },
    { from: 'a', to: 'a', label: 'y' }
  )
  expect(() =>
    applyTextOverlay(
      block,
      {
        overlay: '1.0.0',
        actions: [
          {
            target:
              "$['x-state-machines'].preparation.transitions[?@.from=='a' && @.to=='a' && !@.reason]",
            update: { label: '甲' }
          }
        ]
      },
      'zh.yaml'
    )
  ).toThrow(/matches 2 transitions/)
})

test('an overlay target outside machines, states, and transitions fails', () => {
  const actions = fullOverlay()
  actions[0]!.target = "$['x-state-machines'].preparation.transitions[0]"
  expect(() => apply(actions)).toThrow(/is not a machine, state, or transition/)
})

test('an overlay transition target may space its filter operators freely', () => {
  const actions = fullOverlay()
  actions[2]!.target = actions[2]!.target.replaceAll(' && ', '&&')
  expect(() => apply(actions)).not.toThrow()
})

test('a state summary must be translated independently of its description', () => {
  const actions = fullOverlay()
  delete actions[1]!.update.summary
  expect(() => apply(actions)).toThrow(/has no summary translation/)
})
