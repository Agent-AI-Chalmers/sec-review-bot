import { expectTypeOf, test } from 'vitest'

import type { OperationOptionsById } from '../src/contract-types.generated.js'
import type { OperationHandlers, OperationRequest } from '../src/http/route-handlers.js'

// This file is compiler-analyzed only; the registry is a type fixture, never executed.
declare const handlers: OperationHandlers

test('submission handlers read exactly the contract body', () => {
  expectTypeOf<OperationRequest<'submitPreparedRun'>['body']>().toEqualTypeOf<
    OperationOptionsById['submitPreparedRun']['body']
  >()
})

test('publication step handlers read exactly the contract body', () => {
  expectTypeOf<OperationRequest<'initializePublicationSteps'>['body']>().toEqualTypeOf<
    OperationOptionsById['initializePublicationSteps']['body']
  >()
})

test('publication step path parameters belong to that operation', () => {
  expectTypeOf<OperationRequest<'completePublicationStep'>['params']>().toEqualTypeOf<{
    runId: string
    stepKey: string
  }>()
})

test('publication step keys remain an array of strings', () => {
  expectTypeOf<OperationRequest<'initializePublicationSteps'>['body']['step_keys']>().toEqualTypeOf<
    string[]
  >()
})

test('the handler registry rejects unknown, missing, and mismatched operations', () => {
  // @ts-expect-error Operation names come from the contract.
  void handlers.initializePublicationStepsTypo
  // @ts-expect-error Every contract operation needs a registered handler.
  const missing: OperationHandlers = { getHealth: handlers.getHealth }
  void missing
  // @ts-expect-error A notice claim cannot be used as a publication step request.
  const wrong: OperationHandlers['initializePublicationSteps'] = handlers.renewRunNoticeClaim
  void wrong
})

test('inferred handler requests and success values retain their operation types', () => {
  const registry = {
    initializePublicationSteps: async (request) => {
      expectTypeOf(request.body.step_keys).toEqualTypeOf<string[]>()
      // @ts-expect-error This field belongs to another operation.
      void request.params.noticeId
      // @ts-expect-error Renamed request fields must fail inside the actual registry shape.
      void request.body.step_keysX
    },
    // @ts-expect-error Success values must match this operation's response.
    getPreparationHeartbeatInterval: async () => '1000'
  } satisfies Partial<OperationHandlers>
  void registry
})

test('list filters are top-level query parameters', () => {
  expectTypeOf<OperationRequest<'listRuns'>['query']>().toEqualTypeOf<
    NonNullable<OperationOptionsById['listRuns']['query']>['filter']
  >()
})
