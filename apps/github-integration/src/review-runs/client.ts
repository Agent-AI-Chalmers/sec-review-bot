// Provides the typed HTTP boundary to Review Runs and keeps wire-level
// contract details out of GitHub workflows and coordinators.
import { TextDecoder } from 'node:util'

import { operationRoutes } from './review-runs-api.js'
import type {
  OperationOptionsById,
  OperationResponseById,
  PreparationWork,
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord,
  RunNoticeWork
} from './review-runs-api.js'
import {
  parsePublishContextForWorkflow,
  type PublishContext
} from './publish-context.js'
import { integerEnv } from '../utils/env.js'

export type {
  PublicationStepRecord,
  PublicationWork,
  ReviewRunAdmission,
  ReviewRunRecord,
  RunNoticeWork
}

type JsonObject = Record<string, unknown>

const MAX_REVIEW_RUNS_RESPONSE_BYTES = 4 * 1024 * 1024

type OperationId = keyof OperationOptionsById & keyof typeof operationRoutes

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

export class ReviewRunsSubmissionError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'ReviewRunsSubmissionError'
    this.code = code
  }
}

function serviceUrl(): string {
  const value = process.env.REVIEW_RUNS_SERVICE_URL?.trim()
  if (!value) throw new Error('REVIEW_RUNS_SERVICE_URL is required.')
  return value.replace(/\/+$/, '')
}

function serviceToken(): string {
  const value = process.env.REVIEW_RUNS_SERVICE_TOKEN?.trim()
  if (!value) throw new Error('REVIEW_RUNS_SERVICE_TOKEN is required.')
  return value
}

/** The REST error envelope: `{ error: string, code?: string }` (HTTP 400/404/409/500). */
interface HttpErrorBody {
  error?: string
  code?: string
}

class ReviewRunsResponseTooLargeError extends Error {
  readonly code = 'REVIEW_RUNS_RESPONSE_TOO_LARGE'

  constructor() {
    super('Review Runs returned a response larger than the protocol budget.')
    this.name = 'ReviewRunsResponseTooLargeError'
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_REVIEW_RUNS_RESPONSE_BYTES
  ) {
    await response.body?.cancel()
    throw new ReviewRunsResponseTooLargeError()
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_REVIEW_RUNS_RESPONSE_BYTES) {
        await reader.cancel()
        throw new ReviewRunsResponseTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function parseHttpErrorBody(text: string): HttpErrorBody {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return {}
    return {
      ...('error' in parsed && typeof parsed.error === 'string'
        ? { error: parsed.error }
        : {}),
      ...('code' in parsed && typeof parsed.code === 'string'
        ? { code: parsed.code }
        : {})
    }
  } catch {
    return {}
  }
}

type Operation<Id extends OperationId> = OperationOptionsById[Id]

/** The JSON request body the contract declares for an operation. A `POST` must pass exactly
 * this, so a field renamed in `openapi.yaml` fails the client's typecheck instead of being
 * accepted here and silently stripped or ignored by the service. */
type RequestBody<Id extends OperationId> =
  Operation<Id> extends { body: infer Body } ? Body : never

/** The success body the contract declares for an operation, keyed by status code. */
type SuccessBody<Id extends OperationId> =
  unknown extends OperationResponseById[Id] ? void : OperationResponseById[Id]

class HttpReviewRunsClient {
  readonly connectorId =
    process.env.CONNECTOR_ID?.trim() || 'github-integration:default'

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
    const timeout = setTimeout(
      () => controller.abort(),
      integerEnv('REVIEW_RUNS_REQUEST_TIMEOUT_MS', 30_000)
    )
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
        if (nullOn404 && response.status === 404) {
          await response.body?.cancel()
          return null as SuccessBody<Id>
        }
      }
      let text: string
      try {
        text = await readBoundedResponseText(response)
      } catch (error) {
        if (!(error instanceof ReviewRunsResponseTooLargeError) || response.ok)
          throw error
        throw Object.assign(
          new Error(`Review Runs returned HTTP ${response.status}.`),
          { code: null, status: response.status }
        )
      }
      if (!response.ok) {
        const parsed = parseHttpErrorBody(text)
        // The status is part of the answer, not decoration: a refusal (4xx) is a verdict that
        // classification must tell apart from the same `code` carried by a request that never
        // got an answer. Dropping it here made every refusal look like a transport fault.
        throw Object.assign(
          new Error(
            parsed.error ?? `Review Runs returned HTTP ${response.status}.`
          ),
          { code: parsed.code ?? null, status: response.status }
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
      return (text === '' ? undefined : JSON.parse(text)) as SuccessBody<Id>
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw Object.assign(
          new Error(`Review Runs ${operation} request timed out.`),
          {
            code: 'REVIEW_RUNS_REQUEST_TIMEOUT',
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
      throw new Error(`Review Runs run does not exist: ${runId}`)
    return parsePublishContextForWorkflow(run.workflow, context)
  }

  // Admission deliberately persists an empty context: run identity exists before input
  // preparation discovers the workflow-specific publish target. Review Runs owns the run
  // id, so `run_id` is omitted here and returned on `record`.
  async admitReviewRun(run: {
    workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
    publish_context: JsonObject
    execution_input?: JsonObject
    ingress_kind: 'github_webhook' | 'github_actions_dispatch'
    ingress_key: string
    preparation_input_version: string
    preparation_input: Record<string, unknown>
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
      throw new ReviewRunsSubmissionError(
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

  async claimNextPreparation(): Promise<PreparationWork | null> {
    return await this.request('claimNextPreparation', {}, undefined)
  }

  async checkpointPreparationInput(
    runId: string,
    token: string,
    input: JsonObject
  ): Promise<void> {
    await this.request(
      'checkpointPreparationInput',
      { runId },
      { token, input }
    )
  }

  async claimNextRunNotice(): Promise<RunNoticeWork | null> {
    return await this.request('claimNextRunNotice', {}, undefined)
  }

  async renewRunNoticeClaim(noticeId: string, token: string): Promise<boolean> {
    return await this.request('renewRunNoticeClaim', { noticeId }, { token })
  }

  async completeRunNotice(
    noticeId: string,
    token: string,
    delivered: true,
    commentUrl: string
  ): Promise<boolean>
  async completeRunNotice(
    noticeId: string,
    token: string,
    delivered: false
  ): Promise<boolean>
  async completeRunNotice(
    noticeId: string,
    token: string,
    delivered: boolean,
    commentUrl?: string
  ): Promise<boolean> {
    // The contract states the two cases separately: a delivered notice names its comment, an
    // undelivered one has nowhere to point. The overloads keep that distinction at this seam
    // instead of letting a missing URL reach the server as a runtime error.
    return await this.request(
      'completeRunNotice',
      { noticeId },
      delivered
        ? { token, delivered: true, comment_url: commentUrl as string }
        : { token, delivered: false }
    )
  }

  async preparationHeartbeatIntervalMs(): Promise<number> {
    return await this.request('getPreparationHeartbeatInterval', {})
  }

  async runNoticeHeartbeatIntervalMs(): Promise<number> {
    return await this.request('getRunNoticeHeartbeatInterval', {})
  }

  /**
   * Claim the next publishable run, optionally asking Review Runs to hold the request
   * until one appears. The wait is served where the state lives, so it costs Review Runs
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
      // not belong in Review Runs. A corrupt record must still consume that claim into a
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
    // how Review Runs persists it (as text) and reads it back (`Number(...)`). GitHub object
    // ids arrive as numbers, so normalize here; Review Runs validates bodies without
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

  /** Conclude a step that ran out of attempts, from what the caller found remotely.
   *
   * Passing `found: true` is how a reconciliation that discovers the side effect already
   * happened turns an exhausted step into `succeeded`; `found: false` is the only way a step
   * becomes `terminal_failed`, and it is a claim that the remote system was checked. */
  async settleExhaustedPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    found: {
      remote?: { id?: string | number | null; url?: string | null }
    } | null
  ): Promise<boolean> {
    const remote = found?.remote
    return await this.request(
      'settleExhaustedPublicationStep',
      { runId, stepKey },
      {
        token,
        found: found !== null,
        ...(remote === undefined
          ? {}
          : {
              remote_object: {
                id:
                  remote.id === null || remote.id === undefined
                    ? null
                    : String(remote.id),
                url: remote.url ?? null
              }
            })
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
    failure: { code?: string | null; message: string },
    options: { retry: boolean; retryAfterMs?: number } = { retry: false }
  ): Promise<{ retry_scheduled: boolean }> {
    return await this.request(
      'failPreparation',
      { runId },
      {
        token,
        failure,
        retry: options.retry,
        ...(options.retryAfterMs === undefined
          ? {}
          : { retry_after_ms: options.retryAfterMs })
      }
    )
  }
}

export type ReviewRunsClient = Pick<
  HttpReviewRunsClient,
  | 'connectorId'
  | 'admitReviewRun'
  | 'submitPreparedRun'
  | 'getRun'
  | 'renewPreparationClaim'
  | 'claimNextPreparation'
  | 'checkpointPreparationInput'
  | 'claimNextRunNotice'
  | 'renewRunNoticeClaim'
  | 'completeRunNotice'
  | 'preparationHeartbeatIntervalMs'
  | 'runNoticeHeartbeatIntervalMs'
  | 'renewPublicationClaim'
  | 'publicationHeartbeatIntervalMs'
  | 'claimNextPublication'
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'settleExhaustedPublicationStep'
  | 'failPublicationStep'
  | 'completePublication'
  | 'failPublication'
  | 'failPreparation'
>

/** The publication-step slice of the client.
 *
 * A publisher drives the step protocol and nothing else: it never admits runs, claims
 * preparation, or reads a run back. Naming the slice here means a caller (and a test double)
 * only has to provide what the protocol actually uses, and a misspelled or missing member is a
 * compile error rather than a runtime "not a function".
 *
 * `Pick` over the concrete client keeps each member's exact signature - including return types -
 * so this cannot drift from the real implementation. */
export type PublicationStepStore = Pick<
  ReviewRunsClient,
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'settleExhaustedPublicationStep'
  | 'failPublicationStep'
>

/** The preparation-coordinator slice.
 *
 * It claims preparation work, and it also hands the same store to the
 * trigger commands it runs, so the slice includes what those commands need (`admitReviewRun`,
 * `submitPreparedRun`, the preparation lease, and the optional input checkpoint). Naming the union
 * here keeps the coordinator from requiring the whole 22-method client just to call four of them. */
export type PreparationCoordinatorStore = Pick<
  ReviewRunsClient,
  | 'claimNextPreparation'
  | 'failPreparation'
  | 'admitReviewRun'
  | 'submitPreparedRun'
  | 'renewPreparationClaim'
  | 'preparationHeartbeatIntervalMs'
> & {
  checkpointPreparationInput?: ReviewRunsClient['checkpointPreparationInput']
}

/** The run-notice coordinator owns only the connector's durable notification outbox. */
export type RunNoticeCoordinatorStore = Pick<
  ReviewRunsClient,
  | 'claimNextRunNotice'
  | 'renewRunNoticeClaim'
  | 'runNoticeHeartbeatIntervalMs'
  | 'completeRunNotice'
>

/** The heartbeat slice: what a lease keeper needs, and nothing else.
 *
 * `withPublicationHeartbeat` only renews a claim and asks how often to; it never publishes. Naming
 * this slice lets that helper stay usable (and testable) without a store that can do everything. */
export type PublicationHeartbeatStore = Pick<
  ReviewRunsClient,
  'renewPublicationClaim' | 'publicationHeartbeatIntervalMs'
>

/** The publication-coordinator slice.
 *
 * It claims publishable work, keeps the lease and concludes it - and hands the same store to the
 * publisher, which drives the step protocol. The slice therefore includes `PublicationStepStore`,
 * so one type covers the coordinator's own calls and the protocol it delegates to. */
export type PublicationCoordinatorStore = Pick<
  ReviewRunsClient,
  | 'connectorId'
  | 'claimNextPublication'
  | 'renewPublicationClaim'
  | 'publicationHeartbeatIntervalMs'
  | 'completePublication'
  | 'failPublication'
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'settleExhaustedPublicationStep'
  | 'failPublicationStep'
>

export const reviewRunsClient: ReviewRunsClient = new HttpReviewRunsClient()
