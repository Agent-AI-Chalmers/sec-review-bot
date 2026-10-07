import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { ReviewRunStore } from './review-store.js'
import type { ReviewRunStatus } from './review-store.js'
import type { ControlPlaneWorkflow } from './contracts.js'
import { coordinateReviewRunsOnce, startReviewRunCoordinatorLoop } from './coordinator.js'
import { observeRunnerRun } from './terminal-coordination.js'
import {
  getRunnerRunStatus,
  RUNNER_RUN_NOT_FOUND,
  RunnerSubmissionUncertainError,
  submitRunnerRun
} from './runner-client.js'
import { recoverReviewRunSubmission } from './submission-recovery.js'
import { submitPreparedRun } from './prepared-submission.js'
import { observeRun, type PublicationStepSummary } from './observability.js'

const MAX_BODY_BYTES = 1024 * 1024
const operations = [
  'submit_prepared_run',
  'admit_review_run',
  'getRun',
  'failPreparation',
  'renewPreparationClaim',
  'preparationHeartbeatIntervalMs',
  'claimNextPublication',
  'renewPublicationClaim',
  'initializePublicationSteps',
  'listPublicationSteps',
  'requirePublicationStepClaim',
  'completePublicationStep',
  'failPublicationStep',
  'completePublication',
  'failPublication'
] as const
type Operation = (typeof operations)[number]
const allowedOperations = new Set<string>(operations)
const reviewStatuses = new Set<ReviewRunStatus>([
  'preparing',
  'recovering',
  'queued',
  'running',
  'succeeded',
  'publishing',
  'published',
  'failed'
])
const workflows = new Set<ControlPlaneWorkflow>([
  'issue-review',
  'pull-request-review',
  'repository-review'
])
type ListQueryOptions = NonNullable<Parameters<ReviewRunStore['listRuns']>[0]>

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES)
      throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 })
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function invalidQuery(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_QUERY' })
}

export function decodeRunId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw Object.assign(new Error('run_id must use valid percent-encoding.'), {
      statusCode: 400,
      code: 'INVALID_PATH_PARAMETER'
    })
  }
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
  const status = url.searchParams.get('status')
  if (status !== null) {
    if (!reviewStatuses.has(status as ReviewRunStatus)) throw invalidQuery('status is invalid.')
    options.status = status as ReviewRunStatus
  }
  const workflow = url.searchParams.get('workflow')
  if (workflow !== null) {
    if (!workflows.has(workflow as ControlPlaneWorkflow)) throw invalidQuery('workflow is invalid.')
    options.workflow = workflow as ControlPlaneWorkflow
  }
  for (const name of ['from', 'to'] as const) {
    const value = url.searchParams.get(name)
    if (value !== null) {
      if (Number.isNaN(Date.parse(value))) throw invalidQuery(`${name} must be a valid date.`)
      options[name] = value
    }
  }
  return options
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // Keep operational logs structured, but never serialize request arguments:
  // they may contain runner input, publish context, or claim credentials.
  console.info(JSON.stringify({ event, ...fields }))
}

function isRpcRequest(value: unknown): value is { operation: Operation; args: unknown[] } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.operation === 'string' &&
    allowedOperations.has(record.operation) &&
    Array.isArray(record.args)
  )
}

export async function startControlPlaneServer(): Promise<{ close: () => Promise<void> }> {
  const token = requiredEnv('CONTROL_PLANE_SERVICE_TOKEN')
  const readToken = requiredEnv('CONTROL_PLANE_READ_TOKEN')
  const store = new ReviewRunStore({
    connectionString: requiredEnv('DATABASE_URL'),
    connectorId: process.env.CONNECTOR_ID?.trim() || 'github-app:default'
  })
  await store.initialize()
  const intervalMs = Number.parseInt(
    process.env.AGENT_RUNNER_BACKGROUND_POLL_INTERVAL_MS || '15000',
    10
  )
  const coordinator = startReviewRunCoordinatorLoop({
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15_000,
    runOnce: async () =>
      await coordinateReviewRunsOnce(store, {
        recoverSubmission: async (run) => {
          logEvent('runner_submission_recovery_started', {
            connector_id: store.connector_id,
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
            connector_id: store.connector_id,
            run_id: run.run_id,
            workflow: run.workflow
          })
        },
        observeActiveRun: async (run) => {
          await observeRunnerRun(
            store,
            run,
            getRunnerRunStatus,
            (error) =>
              typeof error === 'object' &&
              error !== null &&
              'name' in error &&
              error.name === 'AgentRunnerServiceError' &&
              (('retryable' in error && error.retryable === false) ||
                ('code' in error && error.code === RUNNER_RUN_NOT_FOUND)),
            (event) => {
              console.info(
                JSON.stringify({ event: event.kind, connector_id: store.connector_id, ...event })
              )
            }
          )
        }
      }),
    onError: (error) => {
      console.error('control_plane_runner_coordination_failed', error)
    }
  })
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        sendJson(response, 200, { status: 'ok' })
        return
      }
      const runQuery =
        request.method === 'GET' ? /^\/v1\/runs\/([^/?]+)$/.exec(request.url ?? '') : null
      const stepsQuery =
        request.method === 'GET'
          ? /^\/v1\/runs\/([^/]+)\/publication-steps$/.exec(request.url ?? '')
          : null
      const listQuery = request.method === 'GET' && request.url?.startsWith('/v1/runs?')
      if (
        (request.method !== 'POST' || request.url !== '/v1/store') &&
        runQuery === null &&
        stepsQuery === null &&
        !listQuery
      ) {
        sendJson(response, 404, { error: 'not_found' })
        return
      }
      const expectedToken =
        runQuery !== null || stepsQuery !== null || listQuery ? readToken : token
      if (request.headers.authorization !== `Bearer ${expectedToken}`) {
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      if (runQuery !== null) {
        const requestedRunId = runQuery[1]
        if (requestedRunId === undefined) throw new Error('Run query did not include a run id.')
        const run = await store.getRun(decodeRunId(requestedRunId))
        if (run === null) {
          sendJson(response, 404, { error: 'run_not_found' })
          return
        }
        sendJson(response, 200, { run: observeRun(run) })
        return
      }
      if (stepsQuery !== null) {
        const requestedRunId = stepsQuery[1]
        if (requestedRunId === undefined)
          throw new Error('Publication step query did not include a run id.')
        const run = await store.getRun(decodeRunId(requestedRunId))
        if (run === null) {
          sendJson(response, 404, { error: 'run_not_found' })
          return
        }
        const steps = await store.listPublicationSteps(run.run_id)
        const summary: PublicationStepSummary[] = steps.map((step) => ({
          step_key: step.step_key,
          status: step.status,
          attempts: step.attempts,
          failure_code: step.failure_code
        }))
        sendJson(response, 200, { run_id: run.run_id, publication_steps: summary })
        return
      }
      if (listQuery) {
        const url = new URL(request.url ?? '/', 'http://control-plane.local')
        const listOptions = parseListQuery(url)
        const runs = await store.listRuns(listOptions)
        const observed = runs.map(observeRun)
        const last = runs.at(-1)
        const next_cursor =
          last === undefined || runs.length < listOptions.limit!
            ? null
            : Buffer.from(`${last.created_at}|${last.run_id}`).toString('base64url')
        sendJson(response, 200, { runs: observed, next_cursor })
        return
      }
      const body = await readJson(request)
      if (!isRpcRequest(body)) {
        sendJson(response, 400, { error: 'invalid_request' })
        return
      }
      const args =
        body.operation === 'admit_review_run' &&
        typeof body.args[0] === 'object' &&
        body.args[0] !== null
          ? [{ ...(body.args[0] as Record<string, unknown>), run_id: randomUUID() }]
          : body.args
      const runId = typeof body.args[0] === 'string' ? body.args[0] : undefined
      logEvent('control_plane_operation_started', {
        operation: body.operation,
        ...(runId === undefined ? {} : { run_id: runId }),
        connector_id: store.connector_id
      })
      if (body.operation === 'submit_prepared_run') {
        const [runId, preparationToken, publishContext, input] = args as [
          string,
          string,
          Record<string, unknown>,
          Record<string, unknown>
        ]
        const result = await submitPreparedRun(
          store,
          { runId, preparationToken, publishContext, input },
          submitRunnerRun
        )
        logEvent('control_plane_operation_completed', {
          operation: body.operation,
          run_id: runId,
          connector_id: store.connector_id
        })
        sendJson(response, 200, { result })
        return
      }
      const method = store[body.operation] as (...operationArgs: unknown[]) => Promise<unknown>
      const result = await method.apply(store, args)
      logEvent('control_plane_operation_completed', {
        operation: body.operation,
        ...(runId === undefined ? {} : { run_id: runId }),
        connector_id: store.connector_id
      })
      sendJson(response, 200, { result })
    } catch (error) {
      const status =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : 500
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
        code:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : undefined
      })
    }
  })
  const port = Number.parseInt(process.env.CONTROL_PLANE_PORT || '8090', 10)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
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
