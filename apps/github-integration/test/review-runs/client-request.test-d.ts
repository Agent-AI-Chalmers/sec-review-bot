// Type-only tests: request bodies, absence, and route literals come from the contract.
import { expectTypeOf, test } from 'vitest'

import type {
  operationRoutes,
  GetInternalRunResponseBody,
  OperationOptionsById
} from '../../src/review-runs/review-runs-api.js'
import type { ReviewRunsClient } from '../../src/review-runs/client.js'

test('publication step initialization requires the run, claim, and step keys', () => {
  expectTypeOf<
    Parameters<ReviewRunsClient['initializePublicationSteps']>
  >().toEqualTypeOf<[string, string, string[]]>()
})

test('getRun preserves the possibility of absence', () => {
  expectTypeOf<
    Awaited<ReturnType<ReviewRunsClient['getRun']>>
  >().toEqualTypeOf<GetInternalRunResponseBody | null>()
})

test('every contract operation has a route', () => {
  expectTypeOf<keyof typeof operationRoutes>().toEqualTypeOf<
    keyof OperationOptionsById
  >()
})

test('the submission path remains a contract literal', () => {
  expectTypeOf<
    typeof operationRoutes.submitPreparedRun.path
  >().toEqualTypeOf<'/v1/runs/{runId}/submission'>()
})

test('the admission method remains a contract literal', () => {
  expectTypeOf<typeof operationRoutes.admitRun.method>().toEqualTypeOf<'post'>()
})
