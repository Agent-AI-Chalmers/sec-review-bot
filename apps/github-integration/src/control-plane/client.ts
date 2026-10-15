import { operationRoutes } from './control-plane-api.js'
import type { components, operations } from './control-plane-api.js'
import {
  parsePublishContextForWorkflow,
  type PublishContext
} from './publish-context.js'

export type ReviewRunRecord = components['schemas']['ReviewRunRecord']
export type ReviewRunAdmission = components['schemas']['ReviewRunAdmission']
export type PublicationWork = components['schemas']['PublicationWork']
export type PublicationStepRecord =
  components['schemas']['PublicationStepRecord']

type JsonObject = Record<string, unknown>

type OperationId = keyof operations

/** The path template the contract serves an operation at, e.g. `/v1/runs/{runId}/submission`.
 * Taken from the generated `operationRoutes` map (a projection of `openapi.yaml`), not from
 * the `paths` type: two operations with identical shapes (both taking `{ token }` and
 * returning a boolean, say) are indistinguishable structurally, so a type-level match would
 * pair an operation with the wrong path. The map is keyed by `operationId`, so it is exact. */
type PathOf<Id extends OperationId> = (typeof operationRoutes)[Id]['path']

/** The HTTP method the contract serves an operation with, from the same generated map. */
type MethodOf<Id extends OperationId> = (typeof operationRoutes)[Id]['method']

/** The `{param}` names a path template declares, as a union. */
type PathParam<T extends string> =
  T extends `${string}{${infer P}}${infer Rest}` ? P | PathParam<Rest> : never

/** Build a request URL from an operation's *own* contract path. The operation is the only
 * routing input: the path is looked up in the generated map rather than passed in, so a call
 * cannot target another operation's URL, and a renamed path in `openapi.yaml` fails to
 * compile here instead of silently calling a stale one. */
function contractPath<Id extends OperationId>(
  operation: Id,
  params: Record<PathParam<PathOf<Id> & string>, string>
): string {
  const template = operationRoutes[operation].path
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = (params as Record<string, string | undefined>)[name]
    if (value === undefined)
      throw new Error(`Missing path parameter ${name} for ${operation}`)
    return encodeURIComponent(value)
  })
}

/** The HTTP method the contract serves an operation with, uppercased for `fetch`, from the
 * same generated map — so the method cannot drift from the operation either. */
function contractMethod<Id extends OperationId>(
  operation: Id
): Uppercase<MethodOf<Id> & string> {
  return operationRoutes[operation].method.toUpperCase() as Uppercase<
    MethodOf<Id> & string
  >
}

export class ControlPlaneSubmissionError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'ControlPlaneSubmissionError'
    this.code = code
  }
}

function serviceUrl(): string {
  const value = process.env.CONTROL_PLANE_SERVICE_URL?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_URL is required.')
  return value.replace(/\/+$/, '')
}

function serviceToken(): string {
  const value = process.env.CONTROL_PLANE_SERVICE_TOKEN?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_TOKEN is required.')
  return value
}

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS ?? '',
    10
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

/** The REST error envelope: `{ error: string, code?: string }` (HTTP 400/404/409/500). */
interface HttpErrorBody {
  error?: string
  code?: string
}

type Operation<Id extends OperationId> = operations[Id]

/** The JSON request body the contract declares for an operation. A `POST` must pass exactly
 * this, so a field renamed in `openapi.yaml` fails the client's typecheck instead of being
 * accepted here and silently stripped or ignored by the service. */
type RequestBody<Id extends OperationId> =
  Operation<Id> extends {
    requestBody: { content: { 'application/json': infer Body } }
  }
    ? Body
    : never

/** The success body the contract declares for an operation, keyed by status code. */
type SuccessBody<Id extends OperationId> =
  Operation<Id> extends {
    responses: { 200: { content: { 'application/json': infer Body } } }
  }
    ? Body
    : void

class HttpControlPlaneClient {
  readonly connectorId =
    process.env.CONNECTOR_ID?.trim() || 'github-app:default'

  // One HTTP request with auth, timeout, and error/status handling. `nullOn404` maps a 404
  // to `null` for reads that distinguish "absent" from "error".
  //
  // The contract's `operationId` is the only routing input: the URL, the HTTP method, the
  // request body shape, and the parsed success value are all derived from it, so an operation
  // cannot be sent to another operation's URL (or with another operation's method or body)
  // without failing to compile.
  private async request<Id extends OperationId>(
    operation: Id,
    params: Record<PathParam<PathOf<Id> & string>, string>,
    body?: RequestBody<Id>,
    nullOn404 = false
  ): Promise<SuccessBody<Id>> {
    const path = contractPath(operation, params)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs())
    timeout.unref?.()
    try {
      const response = await fetch(`${serviceUrl()}${path}`, {
        method: contractMethod(operation),
        headers: {
          authorization: `Bearer ${serviceToken()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      })
      if (!response.ok) {
        if (nullOn404 && response.status === 404) return null as SuccessBody<Id>
        const parsed = (await response
          .json()
          .catch(() => ({}))) as HttpErrorBody
        throw Object.assign(
          new Error(
            parsed.error ?? `Control Plane returned HTTP ${response.status}.`
          ),
          { code: parsed.code ?? null }
        )
      }
      // A success body may legitimately be empty: three operations (`failPreparation`,
      // `initializePublicationSteps`, `requirePublicationStepClaim`) declare a 200 with no
      // content, and the server answers with `reply.code(200).send()` — a zero-byte body. The
      // contract's `SuccessBody` for those operations is `void`, so the caller expects
      // `undefined`. Parsing unconditionally threw `SyntaxError: Unexpected end of JSON input`
      // on every such call, which carried no `code` or HTTP status and was therefore
      // misclassified as a retryable publication fault — the exact "loops forever" failure the
      // terminal-code alignment exists to prevent. Parse only when there is a body.
      const text = await response.text()
      return (text === '' ? undefined : JSON.parse(text)) as SuccessBody<Id>
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw Object.assign(
          new Error(`Control Plane ${operation} request timed out.`),
          {
            code: 'CONTROL_PLANE_REQUEST_TIMEOUT',
            cause: error
          }
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async validateContext(
    runId: string,
    context: PublishContext
  ): Promise<PublishContext> {
    const run = await this.getRun(runId)
    if (run === null)
      throw new Error(`Control Plane run does not exist: ${runId}`)
    return parsePublishContextForWorkflow(run.workflow, context)
  }

  // Admission deliberately persists an empty context: run identity exists before input
  // preparation discovers the workflow-specific publish target. Control Plane owns the run
  // id, so `run_id` is omitted here and returned on `record`.
  async admitReviewRun(run: {
    workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
    publish_context: JsonObject
    runner_input?: JsonObject
    ingress_kind: 'github_webhook' | 'github_actions_dispatch'
    ingress_key: string
  }): Promise<ReviewRunAdmission> {
    return await this.request('admitRun', {}, run)
  }

  async submitPreparedRun(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    const publishContext = await this.validateContext(runId, context)
    try {
      await this.request(
        'submitPreparedRun',
        { runId },
        {
          preparation_token: token,
          publish_context: publishContext,
          input
        }
      )
    } catch (error) {
      const code =
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : null
      throw new ControlPlaneSubmissionError(
        error instanceof Error ? error.message : String(error),
        code
      )
    }
  }

  // Status queries must expose preparing runs whose publish context is not ready.
  // Publication claims below remain the strict persisted-context boundary.
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    return await this.request('getInternalRun', { runId }, undefined, true)
  }

  async renewPreparationClaim(runId: string, token: string): Promise<boolean> {
    return await this.request('renewPreparationClaim', { runId }, { token })
  }

  async preparationHeartbeatIntervalMs(): Promise<number> {
    return await this.request('getPreparationHeartbeatInterval', {})
  }

  /**
   * Claim the next publishable run, optionally asking Control Plane to hold the request
   * until one appears. The wait is served where the state lives, so it costs Control Plane
   * one indexed query per tick instead of a request per poll interval.
   */
  async claimNextPublication(waitMs = 0): Promise<PublicationWork | null> {
    const work = await this.request(
      'claimNextPublication',
      {},
      {
        wait_ms: waitMs
      }
    )
    if (work === null) return null
    try {
      return {
        ...work,
        publish_context: parsePublishContextForWorkflow(
          work.workflow,
          work.publish_context
        )
      }
    } catch (error) {
      // Validation happens after the durable claim because connector-specific context does
      // not belong in Control Plane. A corrupt record must still consume that claim into a
      // terminal failure instead of timing out forever.
      await this.failPublication(
        work.run_id,
        work.claim_token,
        {
          code:
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : 'PUBLISH_CONTEXT_INVALID',
          message: error instanceof Error ? error.message : String(error)
        },
        { retry: false }
      )
      throw error
    }
  }

  async renewPublicationClaim(runId: string, token: string): Promise<boolean> {
    return await this.request('renewPublicationClaim', { runId }, { token })
  }

  async publicationHeartbeatIntervalMs(): Promise<number> {
    return await this.request('getPublicationHeartbeatInterval', {})
  }

  async initializePublicationSteps(
    runId: string,
    token: string,
    stepKeys: string[]
  ): Promise<void> {
    await this.request(
      'initializePublicationSteps',
      { runId },
      {
        token,
        step_keys: stepKeys
      }
    )
  }

  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    return await this.request('listInternalPublicationSteps', { runId })
  }

  async requirePublicationStepClaim(
    runId: string,
    token: string,
    stepKey: string
  ): Promise<void> {
    await this.request(
      'requirePublicationStepClaim',
      { runId, stepKey },
      { token }
    )
  }

  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | number | null; url?: string | null } = {}
  ): Promise<boolean> {
    // The contract carries `remote_object.id` as a string (`type: [string, "null"]`), matching
    // how Control Plane persists it (as text) and reads it back (`Number(...)`). GitHub object
    // ids arrive as numbers, so normalize here; Control Plane validates bodies without
    // coercion, so a raw number would be rejected rather than silently converted.
    const remoteObject = {
      ...(remote.id === undefined
        ? {}
        : { id: remote.id === null ? null : String(remote.id) }),
      url: remote.url ?? null
    }
    return await this.request(
      'completePublicationStep',
      { runId, stepKey },
      {
        token,
        remote_object: remoteObject
      }
    )
  }

  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    failure: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    return await this.request(
      'failPublicationStep',
      { runId, stepKey },
      {
        token,
        failure,
        ...(options.retry === undefined ? {} : { retry: options.retry })
      }
    )
  }

  async completePublication(runId: string, token: string): Promise<boolean> {
    return await this.request(
      'completePublication',
      { runId },
      {
        token
      }
    )
  }

  async failPublication(
    runId: string,
    token: string,
    failure: { code?: string | null; message: string },
    options: { retry: boolean }
  ): Promise<boolean> {
    return await this.request(
      'failPublication',
      { runId },
      {
        token,
        failure,
        retry: options.retry
      }
    )
  }

  async failPreparation(
    runId: string,
    token: string,
    failure: { code?: string | null; message: string }
  ): Promise<void> {
    await this.request(
      'failPreparation',
      { runId },
      {
        token,
        failure
      }
    )
  }
}

export type ControlPlaneClient = Pick<
  HttpControlPlaneClient,
  | 'connectorId'
  | 'admitReviewRun'
  | 'submitPreparedRun'
  | 'getRun'
  | 'renewPreparationClaim'
  | 'preparationHeartbeatIntervalMs'
  | 'renewPublicationClaim'
  | 'publicationHeartbeatIntervalMs'
  | 'claimNextPublication'
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'failPublicationStep'
  | 'completePublication'
  | 'failPublication'
  | 'failPreparation'
>

export const controlPlaneClient: ControlPlaneClient =
  new HttpControlPlaneClient()
