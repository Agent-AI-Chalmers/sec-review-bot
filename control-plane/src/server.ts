import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { ReviewRunStore } from './review-store.js'
import { coordinateReviewRunsOnce, startReviewRunCoordinatorLoop } from './coordinator.js'
import { observeRunnerRun } from './terminal-coordination.js'
import { getRunnerRunStatus, RUNNER_RUN_NOT_FOUND, RunnerSubmissionUncertainError, submitRunnerRun } from './runner-client.js'
import { recoverReviewRunSubmission } from './submission-recovery.js'
import { submitPreparedRun } from './prepared-submission.js'

const MAX_BODY_BYTES = 1024 * 1024
const operations = [
  'submit_prepared_run', 'admit_review_run', 'getRun', 'failPreparation',
  'claimNextPublication', 'renewPublicationClaim', 'initializePublicationSteps',
  'listPublicationSteps', 'requirePublicationStepClaim', 'completePublicationStep',
  'failPublicationStep', 'completePublication', 'failPublication'
] as const
type Operation = typeof operations[number]
const allowedOperations = new Set<string>(operations)

function requiredEnv (name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function readJson (request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 })
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })
  }
}

function sendJson (response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function isRpcRequest (value: unknown): value is { operation: Operation, args: unknown[] } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.operation === 'string' && allowedOperations.has(record.operation) && Array.isArray(record.args)
}

export async function startControlPlaneServer (): Promise<{ close: () => Promise<void> }> {
  const token = requiredEnv('CONTROL_PLANE_SERVICE_TOKEN')
  const store = new ReviewRunStore({
    connectionString: requiredEnv('DATABASE_URL'),
    connectorId: process.env.CONNECTOR_ID?.trim() || 'github-app:default'
  })
  await store.initialize()
  const intervalMs = Number.parseInt(process.env.AGENT_RUNNER_BACKGROUND_POLL_INTERVAL_MS || '15000', 10)
  const coordinator = startReviewRunCoordinatorLoop({
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15_000,
    runOnce: async () => await coordinateReviewRunsOnce(store, {
      recoverSubmission: async run => { await recoverReviewRunSubmission(store, run, {
        submit: submitRunnerRun,
        classifyError: error => ({
          uncertain: error instanceof RunnerSubmissionUncertainError,
          code: error instanceof RunnerSubmissionUncertainError ? 'SUBMISSION_STATE_UNCERTAIN' : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'REVIEW_START_FAILED',
          message: error instanceof Error ? error.message : String(error)
        })
      }) },
      observeActiveRun: async run => { await observeRunnerRun(store, run, getRunnerRunStatus, error =>
        typeof error === 'object' && error !== null && 'name' in error && error.name === 'AgentRunnerServiceError' &&
        (('retryable' in error && error.retryable === false) || ('code' in error && error.code === RUNNER_RUN_NOT_FOUND))) }
    }),
    onError: error => { console.error('control_plane_runner_coordination_failed', error) }
  })
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        sendJson(response, 200, { status: 'ok' })
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/store') {
        sendJson(response, 404, { error: 'not_found' })
        return
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      const body = await readJson(request)
      if (!isRpcRequest(body)) {
        sendJson(response, 400, { error: 'invalid_request' })
        return
      }
      const args = body.operation === 'admit_review_run' && typeof body.args[0] === 'object' && body.args[0] !== null
        ? [{ ...(body.args[0] as Record<string, unknown>), run_id: randomUUID() }]
        : body.args
      if (body.operation === 'submit_prepared_run') {
        const [runId, preparationToken, publishContext, input] = args as [string, string, Record<string, unknown>, Record<string, unknown>]
        sendJson(response, 200, { result: await submitPreparedRun(store, { runId, preparationToken, publishContext, input }, submitRunnerRun) })
        return
      }
      const method = store[body.operation] as (...operationArgs: unknown[]) => Promise<unknown>
      sendJson(response, 200, { result: await method.apply(store, args) })
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
        code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
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
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
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
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
}
