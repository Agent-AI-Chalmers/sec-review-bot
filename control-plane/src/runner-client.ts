import { isIP } from 'node:net'

import type { ControlPlaneWorkflow, RunnerArtifactPublication } from './contracts.js'

type JsonObject = Record<string, unknown>
interface RunnerErrorBody {
  message?: string
  code?: string
  retryable?: boolean
}
interface RunnerResponse {
  run_id?: unknown
  workflow?: unknown
  status: string
  result?: unknown
  error?: unknown
  artifact_publication?: unknown
}

const RUNNER_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed'])

export const RUNNER_RUN_NOT_FOUND = 'RUNNER_RUN_NOT_FOUND'
export interface RunnerRunStatus {
  run_id: string
  workflow: ControlPlaneWorkflow
  status: string
  result?: unknown
  error?: RunnerErrorBody
  artifact_publication?: RunnerArtifactPublication
}
export interface AgentRunnerServiceError extends Error {
  name: 'AgentRunnerServiceError'
  code: string
  retryable: boolean
}

export class RunnerSubmissionUncertainError extends Error {
  readonly code = 'SUBMISSION_STATE_UNCERTAIN'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RunnerSubmissionUncertainError'
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkflow(value: unknown): value is ControlPlaneWorkflow {
  return (
    value === 'issue-review' || value === 'pull-request-review' || value === 'repository-review'
  )
}

function serviceUrl(): string {
  const value = process.env.AGENT_RUNNER_SERVICE_URL?.trim()
  if (!value)
    throw Object.assign(new Error('AGENT_RUNNER_SERVICE_URL is required.'), {
      code: 'RUNNER_SERVICE_URL_MISSING'
    })
  return value.replace(/\/+$/, '')
}

function integerEnv(name: string, fallback: number, allowZero = false): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const value =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return (
    (isIP(value) === 4 && value.split('.')[0] === '127') || (isIP(value) === 6 && value === '::1')
  )
}

function serviceHeaders(url: string): Record<string, string> {
  const token = process.env.AGENT_RUNNER_SERVICE_TOKEN?.trim()
  const parsed = new URL(url)
  if (!token && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw Object.assign(
      new Error('AGENT_RUNNER_SERVICE_TOKEN is required unless Runner uses loopback HTTP.'),
      { code: 'RUNNER_SERVICE_TOKEN_MISSING' }
    )
  }
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  }
}

function runnerError(body: unknown, status: number): AgentRunnerServiceError {
  const source = isRecord(body) && isRecord(body.error) ? (body.error as RunnerErrorBody) : {}
  return Object.assign(new Error(source.message ?? `Runner returned HTTP ${status}.`), {
    name: 'AgentRunnerServiceError' as const,
    code: source.code ?? 'RUNNER_SERVICE_ERROR',
    retryable: source.retryable ?? (status === 429 || status >= 500)
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function isTransientTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
}

async function request(
  path: string,
  init: RequestInit
): Promise<{ response: Response; body: unknown }> {
  const base = serviceUrl()
  const retries = integerEnv('AGENT_RUNNER_SERVICE_REQUEST_RETRIES', 2, true)
  const timeout = integerEnv('AGENT_RUNNER_SERVICE_REQUEST_TIMEOUT_MS', 30_000)
  const delay = integerEnv('AGENT_RUNNER_SERVICE_RETRY_BASE_DELAY_MS', 500)
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    timer.unref?.()
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...serviceHeaders(base), ...init.headers },
        signal: controller.signal
      })
      const text = await response.text()
      const body: unknown = text.trim() ? JSON.parse(text) : null
      if (!isRetryableStatus(response.status) || attempt === retries) return { response, body }
    } catch (error) {
      lastError = error
      if (!isTransientTransportError(error) || attempt === retries) throw error
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, delay * 2 ** attempt))
  }
  throw lastError
}

function parseResponse(
  body: unknown,
  expectedRunId: string,
  expectedWorkflow?: ControlPlaneWorkflow
): RunnerResponse {
  if (!isRecord(body) || typeof body.status !== 'string')
    throw new Error('Runner returned an invalid run response.')
  if (!RUNNER_STATUSES.has(body.status)) {
    throw Object.assign(new Error(`Runner returned an unknown status: ${body.status}.`), {
      name: 'AgentRunnerServiceError' as const,
      code: 'RUNNER_INVALID_STATUS',
      retryable: false
    })
  }
  if (body.run_id !== expectedRunId)
    throw new Error(`Runner returned an unexpected run_id for ${expectedRunId}.`)
  if (
    !isWorkflow(body.workflow) ||
    (expectedWorkflow !== undefined && body.workflow !== expectedWorkflow)
  ) {
    throw new Error(`Runner returned an unexpected workflow for ${expectedRunId}.`)
  }
  return body as unknown as RunnerResponse
}

export async function submitRunnerRun({
  workflow,
  run_id,
  input
}: {
  workflow: ControlPlaneWorkflow
  run_id: string
  input: JsonObject
}): Promise<void> {
  let result: { response: Response; body: unknown }
  try {
    result = await request(`/v1/workflows/${encodeURIComponent(workflow)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ run_id, input })
    })
  } catch (error) {
    throw new RunnerSubmissionUncertainError(
      `Runner submission state is uncertain for run ${run_id}.`,
      { cause: error }
    )
  }
  if (!result.response.ok) {
    if (isRetryableStatus(result.response.status)) {
      throw new RunnerSubmissionUncertainError(
        `Runner submission returned HTTP ${result.response.status} for run ${run_id}.`
      )
    }
    throw runnerError(result.body, result.response.status)
  }
  try {
    parseResponse(result.body, run_id, workflow)
  } catch (error) {
    throw new RunnerSubmissionUncertainError(
      `Runner accepted run ${run_id}, but returned an invalid creation response.`,
      { cause: error }
    )
  }
}

export async function getRunnerRunStatus(
  runId: string,
  workflow?: ControlPlaneWorkflow
): Promise<RunnerRunStatus> {
  const { response, body } = await request(`/v1/runs/${encodeURIComponent(runId)}`, {
    method: 'GET'
  })
  if (!response.ok) throw runnerError(body, response.status)
  const parsed = parseResponse(body, runId, workflow)
  return {
    run_id: runId,
    workflow: parsed.workflow as ControlPlaneWorkflow,
    status: parsed.status,
    ...(Object.hasOwn(parsed, 'result') ? { result: parsed.result } : {}),
    ...(isRecord(parsed.error) ? { error: parsed.error as RunnerErrorBody } : {}),
    ...(isRecord(parsed.artifact_publication)
      ? {
          artifact_publication: parsed.artifact_publication as unknown as RunnerArtifactPublication
        }
      : {})
  }
}
