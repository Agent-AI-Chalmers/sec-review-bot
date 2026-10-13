import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import openapiGlue from '@platformatic/fastify-openapi-glue'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import { ReviewRunStore } from './review-store.js'
import type { PublicationStatus, RunnerStatus } from './review-store.js'
import { type ControlPlaneWorkflow } from './contracts.js'
import { coordinateReviewRunsOnce, startReviewRunCoordinatorLoop } from './coordinator.js'
import { observeRunnerRun } from './terminal-coordination.js'
import {
  getRunnerRunStatus,
  getRunnerRunStatuses,
  isTerminalRunnerPollingError,
  RunnerSubmissionUncertainError,
  submitRunnerRun,
  type RunnerRunStatus,
  type RunnerRunStatusBatch
} from './runner-client.js'
import { recoverReviewRunSubmission } from './submission-recovery.js'
import { submitPreparedRun } from './prepared-submission.js'
import { observePublicationStep, observeRun } from './observability.js'
import { DeterministicControlPlaneError, PUBLICATION_STEP_ERROR_CODES } from './errors.js'

const MAX_BODY_BYTES = 1024 * 1024

/** Fastify options shared by the server and its tests. `removeAdditional: false` makes the
 * contract's `additionalProperties: false` mean what it says — a request with an undeclared
 * field is rejected, rather than having the field silently stripped (Fastify's ajv default),
 * which would make the contract overstate the validation. */
export const CONTROL_PLANE_FASTIFY_OPTIONS = {
  bodyLimit: MAX_BODY_BYTES,
  ajv: { customOptions: { removeAdditional: false } }
} as const
// Statuses whose handling needs the run record itself, because the terminal writes
// persist the result, the error, and the artifact reference. Every other status is
// answered from the pass's batch, so a poll where nothing changed costs one request
// rather than one per run.
const STATUSES_NEEDING_RUN_RECORD = new Set(['succeeded', 'failed'])

/**
 * Answer a run's status from the batch the pass already read, and fetch the full record
 * only when the caller is about to store something from it.
 */
function runnerStatusFromBatch(
  batch: RunnerRunStatusBatch
): (runId: string, workflow: ControlPlaneWorkflow) => Promise<RunnerRunStatus> {
  return async (runId, workflow) => {
    const status = batch.byRunId.get(runId)
    if (status !== undefined && !STATUSES_NEEDING_RUN_RECORD.has(status)) {
      return { run_id: runId, workflow, status }
    }
    // A terminal status, or a run this pass did not learn about, needs the record itself.
    return await getRunnerRunStatus(runId, workflow)
  }
}
// The list-query filter values are constrained by the contract's query schema (glue mounts it
// on the route), so there is no enumeration to restate here.
// The error-envelope `code` values. `INVALID_QUERY` is the run-list query filter; the four
// `PUBLICATION_STEP_*` codes also surface here, carried by the REST write routes for
// deterministic publication failures the client must classify as terminal.
const errorCodeEnum = ['INVALID_QUERY', ...Object.values(PUBLICATION_STEP_ERROR_CODES)]
type ListQueryOptions = NonNullable<Parameters<ReviewRunStore['listRunsPage']>[0]>

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function invalidQuery(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_QUERY' })
}

// The list-query filters are validated by the contract's query schema (glue mounts it on the
// route), so this only does what a schema cannot express: the cursor's base64 structure, and
// normalizing `from`/`to` to a canonical instant before binding (Date.parse accepts inputs like
// `1` that `'1'::timestamptz` rejects, which surfaced as a 500 instead of a 400).
function parseListQuery(url: URL): ListQueryOptions {
  const rawLimit = url.searchParams.get('limit')
  const options: ListQueryOptions = {
    limit: rawLimit === null ? 50 : Number(rawLimit)
  }
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null) {
    let decoded: string
    try {
      decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    } catch {
      throw invalidQuery('cursor must be a valid run list cursor.')
    }
    const [createdAt, runId, extra] = decoded.split('|')
    if (!createdAt || !runId || extra !== undefined || Number.isNaN(Date.parse(createdAt))) {
      throw invalidQuery('cursor must be a valid run list cursor.')
    }
    options.cursor = cursor
  }
  const executionStatus = url.searchParams.get('execution_status')
  if (executionStatus !== null) options.execution_status = executionStatus as RunnerStatus
  const publicationStatus = url.searchParams.get('publication_status')
  if (publicationStatus !== null)
    options.publication_status = publicationStatus as PublicationStatus
  const workflow = url.searchParams.get('workflow')
  if (workflow !== null) options.workflow = workflow as ControlPlaneWorkflow
  for (const name of ['from', 'to'] as const) {
    const value = url.searchParams.get(name)
    if (value !== null) {
      // The route schema already pinned the date-time format; this canonicalizes it.
      options[name] = new Date(Date.parse(value)).toISOString()
    }
  }
  return options
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // Keep operational logs structured, but never serialize request arguments:
  // they may contain runner input, publish context, or claim credentials.
  console.info(JSON.stringify({ event, ...fields }))
}

interface ControlPlaneRouteDeps {
  store: ReviewRunStore
  serviceToken: string
  readToken: string
}

/** Locate the OpenAPI contract relative to this module, not the process CWD.
 *
 * fastify-openapi-glue resolves a relative `specification` against the CWD, which breaks as
 * soon as the server runs from a different directory (notably the container, where only
 * `dist/` is present). The build copies the contract next to the compiled output
 * (`copy:spec`), so the compiled server finds it first; running from source (tsx) falls back
 * to the repository's contracts tree. */
function resolveSpecPath(): string {
  const candidates = [
    new URL('./openapi.yaml', import.meta.url), // dist/openapi.yaml (built)
    new URL('../../contracts/control-plane-api/openapi.yaml', import.meta.url) // src/ -> repo contracts/
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return fileURLToPath(candidate)
  }
  throw new Error(
    `OpenAPI contract not found. Looked for ${candidates.map((c) => fileURLToPath(c)).join(', ')}.`
  )
}

/** Register the Control Plane HTTP surface from the OpenAPI contract. Routes, request/response
 * schemas, and security all come from `contracts/control-plane-api/openapi.yaml` via
 * fastify-openapi-glue; the handlers below only carry the domain logic against the store.
 * Kept separate from `startControlPlaneServer` so the routes can be registered with a stub
 * store (for tests) without a database.
 */
export async function registerControlPlaneRoutes(
  app: FastifyInstance,
  deps: ControlPlaneRouteDeps
): Promise<void> {
  const { store, serviceToken, readToken } = deps

  // Errors propagate to the Fastify error handler, which maps a DeterministicControlPlaneError
  // to 409 + code and keeps every other fault a message-free 500; handlers stay domain-only.

  // The handlers, keyed by operationId. Each handler calls the store directly and does only
  // the domain logic: routing, body/query/path validation, and auth come from the OpenAPI
  // spec via fastify-openapi-glue, so nothing here re-states a schema.
  const handlers: Record<string, (request: FastifyRequest, reply: FastifyReply) => unknown> = {
    getHealth: async () => ({ status: 'ok' }),

    listRuns: async (request) => {
      const url = new URL(request.url ?? '/', 'http://control-plane.local')
      const listOptions = parseListQuery(url)
      const { runs, next_cursor } = await store.listRunsPage(listOptions)
      return { runs: runs.map(observeRun), next_cursor }
    },

    getRun: async (request, reply) => {
      const { runId } = request.params as { runId: string }
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return { run: observeRun(run) }
    },

    listRunPublicationSteps: async (request, reply) => {
      const { runId } = request.params as { runId: string }
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      const steps = await store.listPublicationSteps(run.run_id)
      return { run_id: run.run_id, publication_steps: steps.map(observePublicationStep) }
    },

    admitRun: async (request) => {
      const body = request.body as {
        workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
        publish_context: Record<string, unknown>
        runner_input?: Record<string, unknown>
        ingress_kind: 'github_webhook' | 'github_actions_dispatch'
        ingress_key: string
      }
      return await store.admitReviewRun({ run_id: randomUUID(), ...body })
    },

    submitPreparedRun: async (request) => {
      const { runId } = request.params as { runId: string }
      const { preparation_token, publish_context, input } = request.body as {
        preparation_token: string
        publish_context: Record<string, unknown>
        input: Record<string, unknown>
      }
      return await submitPreparedRun(
        store,
        { runId, preparationToken: preparation_token, publishContext: publish_context, input },
        submitRunnerRun
      )
    },

    renewPreparationClaim: async (request) => {
      const { runId } = request.params as { runId: string }
      const { token } = request.body as { token: string }
      return await store.renewPreparationClaim(runId, token)
    },

    failPreparation: async (request) => {
      const { runId } = request.params as { runId: string }
      const { token, failure } = request.body as {
        token: string
        failure: { code?: string | null; message: string }
      }
      await store.failPreparation(runId, token, failure)
      return null
    },

    claimNextPublication: async (request) => {
      const { wait_ms } = request.body as { wait_ms?: number }
      return await store.claimNextPublication(wait_ms ?? 0)
    },

    renewPublicationClaim: async (request) => {
      const { runId } = request.params as { runId: string }
      const { token } = request.body as { token: string }
      return await store.renewPublicationClaim(runId, token)
    },

    initializePublicationSteps: async (request) => {
      const { runId } = request.params as { runId: string }
      const { token, step_keys } = request.body as { token: string; step_keys: string[] }
      await store.initializePublicationSteps(runId, token, step_keys)
      return null
    },

    requirePublicationStepClaim: async (request) => {
      const { runId, stepKey } = request.params as { runId: string; stepKey: string }
      const { token } = request.body as { token: string }
      await store.requirePublicationStepClaim(runId, token, stepKey)
      return null
    },

    completePublicationStep: async (request) => {
      const { runId, stepKey } = request.params as { runId: string; stepKey: string }
      const { token, remote_object } = request.body as {
        token: string
        remote_object?: { id?: string | number | null; url?: string | null }
      }
      return await store.completePublicationStep(runId, token, stepKey, remote_object ?? {})
    },

    failPublicationStep: async (request) => {
      const { runId, stepKey } = request.params as { runId: string; stepKey: string }
      const { token, failure, retry } = request.body as {
        token: string
        failure: { code?: string | null; message: string }
        retry?: boolean
      }
      return await store.failPublicationStep(
        runId,
        token,
        stepKey,
        failure,
        retry === undefined ? {} : { retry }
      )
    },

    completePublication: async (request) => {
      const { runId } = request.params as { runId: string }
      const { token } = request.body as { token: string }
      return await store.completePublication(runId, token)
    },

    failPublication: async (request) => {
      const { runId } = request.params as { runId: string }
      const { token, failure, retry } = request.body as {
        token: string
        failure: { code?: string | null; message: string }
        retry: boolean
      }
      return await store.failPublication(runId, token, failure, { retry })
    },

    getInternalRun: async (request, reply) => {
      const { runId } = request.params as { runId: string }
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return reply.send(run)
    },

    listInternalPublicationSteps: async (request, reply) => {
      const { runId } = request.params as { runId: string }
      const run = await store.getRun(runId)
      if (run === null) return reply.code(404).send({ error: 'run_not_found' })
      return reply.send(await store.listPublicationSteps(run.run_id))
    },

    getPreparationHeartbeatInterval: async () => store.preparationHeartbeatIntervalMs(),

    getPublicationHeartbeatInterval: async () => store.publicationHeartbeatIntervalMs()
  }

  // Error/not-found handlers belong to this HTTP surface, so they are registered here (and
  // before fastify-openapi-glue registers its child scope) rather than in
  // startControlPlaneServer: otherwise handler-thrown errors would get Fastify's default
  // envelope, and the surface could not be exercised without a database.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' })
  })

  app.setErrorHandler((error, _request, reply) => {
    // A deterministic publication failure is a state conflict, not an internal fault: it
    // returns 409 with its PUBLICATION_STEP_* code so the client can classify it as terminal.
    // Handling it here (rather than per-handler) keeps every store method that can throw it
    // covered, including ones added later.
    if (error instanceof DeterministicControlPlaneError) {
      return reply.code(409).send({ error: error.message, code: error.code })
    }
    const errorCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null
    // Defense in depth: a Postgres datetime parse error (22007/22008) can only
    // originate from a bad `from`/`to` filter.
    if (errorCode === '22007' || errorCode === '22008') {
      return reply.code(400).send({ error: 'from/to must be a valid date.', code: 'INVALID_QUERY' })
    }
    if (errorCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Request body is too large.' })
    }
    if (errorCode === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.code(400).send({ error: 'Request body must be valid JSON.' })
    }
    // A request rejected by the contract's own schema (glue mounts it as the route's query /
    // body schema) is the caller's input being invalid, so it uses the documented
    // INVALID_QUERY envelope rather than Fastify's default FST_ERR_VALIDATION shape.
    if (errorCode === 'FST_ERR_VALIDATION') {
      const detail = error instanceof Error ? error.message : String(error)
      return reply.code(400).send({ error: detail, code: 'INVALID_QUERY' })
    }
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
    // Only surface codes in the closed set; internal codes (e.g. Postgres SQLSTATE)
    // must not leak into the envelope, which would also break the OpenAPI enum.
    const code = errorCode !== null && errorCodeEnum.includes(errorCode) ? errorCode : undefined
    // An unexpected internal fault (5xx) must not leak its message (which may carry SQLSTATE
    // or connection details); the caller only learns that the request failed. Known 4xx
    // results keep their message, since those are the caller's own input being rejected.
    const message =
      status >= 500 ? 'Internal error' : error instanceof Error ? error.message : String(error)
    return reply.code(status).send({
      error: message,
      ...(code === undefined ? {} : { code })
    })
  })

  await app.register(openapiGlue, {
    specification: resolveSpecPath(),
    operationResolver: (operationId) => {
      const handler = handlers[operationId]
      if (handler === undefined) {
        throw new Error(`No handler registered for operation ${operationId}`)
      }
      // Log every durable operation with its identity (the README promises connector_id and
      // run_id), wrapping here so a new operation is logged without repeating the call. Only
      // identifiers are logged, never request arguments, which may carry claim credentials.
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const runId = (request.params as { runId?: string }).runId
        logEvent('control_plane_operation_started', {
          operation: operationId,
          ...(runId === undefined ? {} : { run_id: runId }),
          connector_id: store.connectorId
        })
        const result = await handler(request, reply)
        logEvent('control_plane_operation_completed', {
          operation: operationId,
          ...(runId === undefined ? {} : { run_id: runId }),
          connector_id: store.connectorId
        })
        return result
      }
    },
    securityHandlers: {
      serviceToken: async (request: FastifyRequest) => {
        if (request.headers.authorization !== `Bearer ${serviceToken}`) {
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
        }
      },
      readToken: async (request: FastifyRequest) => {
        if (request.headers.authorization !== `Bearer ${readToken}`) {
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
        }
      }
    }
  })
}

export async function startControlPlaneServer(): Promise<{ close: () => Promise<void> }> {
  const token = requiredEnv('CONTROL_PLANE_SERVICE_TOKEN')
  const readToken = requiredEnv('CONTROL_PLANE_READ_TOKEN')
  const store = new ReviewRunStore({
    connectionString: requiredEnv('DATABASE_URL'),
    connectorId: process.env.CONNECTOR_ID?.trim() || 'github-app:default'
  })
  await store.initialize()
  const configuredIntervalMs = Number.parseInt(
    process.env.AGENT_RUNNER_BACKGROUND_POLL_INTERVAL_MS || '15000',
    10
  )
  const intervalMs =
    Number.isFinite(configuredIntervalMs) && configuredIntervalMs > 0
      ? configuredIntervalMs
      : 15_000
  const coordinator = startReviewRunCoordinatorLoop({
    intervalMs,
    runOnce: async () =>
      await coordinateReviewRunsOnce(store, {
        recoverSubmission: async (run) => {
          logEvent('runner_submission_recovery_started', {
            connector_id: store.connectorId,
            run_id: run.run_id,
            workflow: run.workflow
          })
          await recoverReviewRunSubmission(store, run, {
            submit: submitRunnerRun,
            classifyError: (error) => ({
              uncertain: error instanceof RunnerSubmissionUncertainError,
              code:
                error instanceof RunnerSubmissionUncertainError
                  ? 'SUBMISSION_STATE_UNCERTAIN'
                  : error instanceof Error && 'code' in error && typeof error.code === 'string'
                    ? error.code
                    : 'REVIEW_START_FAILED',
              message: error instanceof Error ? error.message : String(error)
            })
          })
          logEvent('runner_submission_recovery_completed', {
            connector_id: store.connectorId,
            run_id: run.run_id,
            workflow: run.workflow
          })
        },
        readRunnerStatuses: (runs) => getRunnerRunStatuses(runs.map((run) => run.run_id)),
        observeActiveRun: async (run, statuses) => {
          await observeRunnerRun(
            store,
            run,
            runnerStatusFromBatch(statuses),
            isTerminalRunnerPollingError,
            (event) => {
              console.info(
                JSON.stringify({ event: event.kind, connector_id: store.connectorId, ...event })
              )
            }
          )
        }
      }),
    onError: (error) => {
      console.error('control_plane_runner_coordination_failed', error)
    }
  })
  const app = Fastify(CONTROL_PLANE_FASTIFY_OPTIONS)

  await registerControlPlaneRoutes(app, { store, serviceToken: token, readToken })

  const port = Number.parseInt(process.env.CONTROL_PLANE_PORT || '8090', 10)
  await app.listen({ port, host: '0.0.0.0' })
  return {
    close: async () => {
      await app.close()
      await coordinator.stop()
      await store.close()
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  const running = await startControlPlaneServer()
  const shutdown = async (): Promise<void> => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => {
    void shutdown()
  })
  process.once('SIGTERM', () => {
    void shutdown()
  })
}
