import { randomUUID } from 'node:crypto'

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
const runnerStatuses = new Set<RunnerStatus>([
  'preparing',
  'recovering',
  'queued',
  'running',
  'succeeded',
  'failed'
])
const publicationStatuses = new Set<PublicationStatus>([
  'pending',
  'publishing',
  'published',
  'failed',
  'skipped'
])
const workflows = new Set<ControlPlaneWorkflow>([
  'issue-review',
  'pull-request-review',
  'repository-review'
])
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

function parseListQuery(url: URL): ListQueryOptions {
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 50 : Number(rawLimit)
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit))) {
    throw invalidQuery('limit must be an integer.')
  }
  if (limit < 1 || limit > 100) throw invalidQuery('limit must be between 1 and 100.')

  const options: ListQueryOptions = { limit }
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
  if (executionStatus !== null) {
    if (!runnerStatuses.has(executionStatus as RunnerStatus)) {
      throw invalidQuery('execution_status is invalid.')
    }
    options.execution_status = executionStatus as RunnerStatus
  }
  const publicationStatus = url.searchParams.get('publication_status')
  if (publicationStatus !== null) {
    if (!publicationStatuses.has(publicationStatus as PublicationStatus)) {
      throw invalidQuery('publication_status is invalid.')
    }
    options.publication_status = publicationStatus as PublicationStatus
  }
  const workflow = url.searchParams.get('workflow')
  if (workflow !== null) {
    if (!workflows.has(workflow as ControlPlaneWorkflow)) throw invalidQuery('workflow is invalid.')
    options.workflow = workflow as ControlPlaneWorkflow
  }
  for (const name of ['from', 'to'] as const) {
    const value = url.searchParams.get(name)
    if (value !== null) {
      const parsed = Date.parse(value)
      if (Number.isNaN(parsed)) throw invalidQuery(`${name} must be a valid date.`)
      // Normalize to a canonical ISO-8601 instant before binding. Date.parse
      // accepts inputs like `1` (year 2001) that `'1'::timestamptz` rejects; if we
      // bound the raw string, Postgres raised `22007` and the generic catch leaked
      // the SQLSTATE as a 500 instead of the documented 400 INVALID_QUERY.
      options[name] = new Date(parsed).toISOString()
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

  // A deterministic publication failure reaches the client with its string code (classified
  // terminal on the github side) as a 409; anything else is a generic 500.
  const writeError = (reply: FastifyReply, error: unknown): void => {
    if (error instanceof DeterministicControlPlaneError) {
      reply.code(409).send({ error: error.message, code: error.code })
      return
    }
    reply.code(500).send({ error: 'Internal error' })
  }

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

    admitRun: async (request, reply) => {
      const body = request.body as {
        workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
        publish_context: Record<string, unknown>
        runner_input?: Record<string, unknown>
        ingress_kind: 'github_webhook' | 'github_actions_dispatch'
        ingress_key: string
      }
      try {
        return await store.admitReviewRun({ run_id: randomUUID(), ...body })
      } catch (error) {
        return writeError(reply, error)
      }
    },

    submitPreparedRun: async (request, reply) => {
      const { runId } = request.params as { runId: string }
      const { preparation_token, publish_context, input } = request.body as {
        preparation_token: string
        publish_context: Record<string, unknown>
        input: Record<string, unknown>
      }
      try {
        return await submitPreparedRun(
          store,
          { runId, preparationToken: preparation_token, publishContext: publish_context, input },
          submitRunnerRun
        )
      } catch (error) {
        return writeError(reply, error)
      }
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
      return await store.failPublicationStep(runId, token, stepKey, failure, retry === undefined ? {} : { retry })
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

  await app.register(openapiGlue, {
    specification: '../contracts/control-plane-api/openapi.yaml',
    operationResolver: (operationId) => {
      const handler = handlers[operationId]
      if (handler === undefined) {
        throw new Error(`No handler registered for operation ${operationId}`)
      }
      return handler
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
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES })

  // Error/not-found handlers must be registered on the root instance *before* the routes
  // (and before fastify-openapi-glue registers its child scope), otherwise handler-thrown
  // errors get Fastify's default envelope instead of the Control Plane error envelope.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' })
  })

  app.setErrorHandler((error, _request, reply) => {
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
    return reply.code(status).send({
      error: error instanceof Error ? error.message : String(error),
      ...(code === undefined ? {} : { code })
    })
  })

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
