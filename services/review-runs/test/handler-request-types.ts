import type {
  InitializePublicationStepsOptions,
  ListRunsOptions,
  SubmitPreparedRunOptions
} from '../src/contract-types-generated.js'
import type {
  OperationHandlers,
  OperationRequest
} from '../src/http/route-handlers.js'

type Expect<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

/** The body an operation's handler reads is exactly the body the contract declares — so a
 * renamed, added, or removed field in `openapi.yaml` breaks the handler, not the caller. */
export type SubmissionBodyMatchesContract = Expect<
  Equals<
    OperationRequest<'submitPreparedRun'>['body'],
    SubmitPreparedRunOptions['body']
  >
>

export type PublicationStepsBodyMatchesContract = Expect<
  Equals<
    OperationRequest<'initializePublicationSteps'>['body'],
    InitializePublicationStepsOptions['body']
  >
>

export type PathParamsMatchContract = Expect<
  Equals<
    OperationRequest<'completePublicationStep'>['params'],
    { runId: string; stepKey: string }
  >
>

/** The handler reads `step_keys`, the name the contract declares. If the contract renames it,
 * this stops compiling — which is the regression that motivated the operation-specific registry. */
export type PublicationStepsBodyExposesContractFields = Expect<
  Equals<
    OperationRequest<'initializePublicationSteps'>['body']['step_keys'],
    string[]
  >
>

/** The registry must reject unknown operations, missing handlers, and handlers wired to
 * another operation's request. These checks run with the package typecheck. */
export function checkRegistryTypes(handlers: OperationHandlers): void {
  // @ts-expect-error Operation names come from the contract.
  void handlers.initializePublicationStepsTypo

  // @ts-expect-error Every contract operation needs a registered handler.
  const missing: OperationHandlers = { getHealth: handlers.getHealth }
  void missing

  // @ts-expect-error A notice claim cannot be used as a publication step request.
  const wrong: OperationHandlers['initializePublicationSteps'] =
    handlers.renewRunNoticeClaim
  void wrong
}

export const checkInferredRequest = {
  initializePublicationSteps: async (request) => {
    const keys: string[] = request.body.step_keys
    void keys
    // @ts-expect-error This field belongs to another operation.
    void request.params.noticeId
    // @ts-expect-error Renamed request fields must fail inside the actual registry shape.
    void request.body.step_keysX
  },
  // @ts-expect-error Success values must match this operation's response.
  getPreparationHeartbeatInterval: async () => '1000'
} satisfies Partial<OperationHandlers>

/** OpenAPI form/explode exposes filter properties directly, without a filter wrapper. */
export type ListQueryMatchesWireContract = Expect<
  Equals<
    OperationRequest<'listRuns'>['query'],
    NonNullable<ListRunsOptions['query']>['filter']
  >
>
