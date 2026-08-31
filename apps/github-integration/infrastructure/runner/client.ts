import { isIP } from 'node:net'

import { logInfo } from '../../utils/logger.js'

export type WorkflowName = 'issue-review' | 'pull-request-review' | 'repository-review'

type JsonObject = Record<string, unknown>

const DEFAULT_RUNNER_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RUNNER_REQUEST_RETRIES = 2
const DEFAULT_RUNNER_RETRY_BASE_DELAY_MS = 500
const RUNNER_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

interface RunnerRequestBody {
  run_id: string
  input: JsonObject
  runtime?: JsonObject
}

interface RunnerServiceErrorBody {
  message?: string
  code?: string
  category?: string
  retryable?: boolean
  details?: JsonObject
}

export interface AgentRunnerServiceError extends Error {
  name: 'AgentRunnerServiceError'
  code: string
  category: string
  retryable: boolean
  details: JsonObject
  run_id: string | null
  workflow: WorkflowName | null
}

export interface RunnerWorkflowResponse {
  run_id: string
  workflow: WorkflowName
  result: unknown
}

export interface SubmittedRunnerRun {
  run_id: string
  workflow: WorkflowName
  status: string
}

export interface RunnerRunStatus {
  run_id: string | null
  workflow: WorkflowName | null
  status: string
  result?: unknown
  error?: RunnerServiceErrorBody
}

interface RunnerServiceQueuedResponse {
  run_id?: string
  workflow?: WorkflowName
  status: string
}

interface RunnerServiceStatusResponse extends RunnerServiceQueuedResponse {
  result?: unknown
  error?: RunnerServiceErrorBody
}

function isRecord (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runnerServiceUrl (): string {
  const value = process.env.AGENT_RUNNER_SERVICE_URL
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim().replace(/\/+$/, '')
  }

  const error = new Error('AGENT_RUNNER_SERVICE_URL is required.') as Error & { code: string }
  error.code = 'RUNNER_SERVICE_URL_MISSING'
  throw error
}

function runnerServiceToken (): string | null {
  const value = process.env.AGENT_RUNNER_SERVICE_TOKEN
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function isLoopbackHostname (hostname: string): boolean {
  if (hostname === 'localhost') {
    return true
  }

  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  const ipVersion = isIP(normalized)

  if (ipVersion === 4) {
    return normalized.split('.')[0] === '127'
  }

  return ipVersion === 6 && normalized === '::1'
}

function isUnauthenticatedRunnerServiceUrlAllowed (service_url: string): boolean {
  try {
    const parsed = new URL(service_url)
    return parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

function requireRunnerServiceToken (service_url: string): string | null {
  const token = runnerServiceToken()
  if (token !== null || isUnauthenticatedRunnerServiceUrlAllowed(service_url)) {
    return token
  }

  const error = new Error(
    'AGENT_RUNNER_SERVICE_TOKEN is required unless AGENT_RUNNER_SERVICE_URL is loopback HTTP.'
  ) as Error & { code: string }
  error.code = 'RUNNER_SERVICE_TOKEN_MISSING'
  throw error
}

function positiveIntegerEnv (name: string, default_value: number): number {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') {
    return default_value
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : default_value
}

function runnerRequestTimeoutMs (): number {
  return positiveIntegerEnv('AGENT_RUNNER_SERVICE_REQUEST_TIMEOUT_MS', DEFAULT_RUNNER_REQUEST_TIMEOUT_MS)
}

function runnerRequestRetries (): number {
  return positiveIntegerEnv('AGENT_RUNNER_SERVICE_REQUEST_RETRIES', DEFAULT_RUNNER_REQUEST_RETRIES)
}

function runnerRetryBaseDelayMs (): number {
  return positiveIntegerEnv('AGENT_RUNNER_SERVICE_RETRY_BASE_DELAY_MS', DEFAULT_RUNNER_RETRY_BASE_DELAY_MS)
}

function buildRunnerRequestBody ({
  input,
  runtime,
  run_id
}: {
  input: JsonObject
  runtime?: JsonObject
  run_id: string
}): RunnerRequestBody {
  if (typeof run_id !== 'string' || run_id === '') {
    throw new Error('Runner run_id is missing before dispatch.')
  }
  if (!RUNNER_RUN_ID_PATTERN.test(run_id)) {
    throw new Error('Runner run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ before dispatch.')
  }

  return {
    run_id,
    input,
    ...(runtime ? { runtime } : {})
  }
}

function validateRunnerInput ({ workflow, input }: { workflow: WorkflowName, input: JsonObject }): void {
  if (!isRecord(input)) {
    throw new Error(`Runner input is missing before ${workflow} dispatch.`)
  }
}

function logRunnerRequestDiagnostics ({
  service_url,
  workflow,
  request
}: {
  service_url: string
  workflow: WorkflowName
  request: RunnerRequestBody
}): void {
  logInfo('runner_dispatch_started', {
    transport: 'http',
    service_url: service_url,
    input_type: typeof request.input,
    run_id: request.run_id,
    workflow
  })
}

function buildServiceError (response: {
  run_id?: string | null
  workflow?: WorkflowName | null
  error?: RunnerServiceErrorBody
}): AgentRunnerServiceError {
  const error = new Error(response.error?.message ?? 'Agent runner returned an unknown service error.') as AgentRunnerServiceError

  error.name = 'AgentRunnerServiceError'
  error.code = response.error?.code ?? 'RUNNER_SERVICE_ERROR'
  error.category = response.error?.category ?? 'runtime'
  error.retryable = response.error?.retryable ?? false
  error.details = response.error?.details ?? {}
  error.run_id = response.run_id ?? null
  error.workflow = response.workflow ?? null

  return error
}

function serviceHeaders (service_url: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  const token = requireRunnerServiceToken(service_url)
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

function isRetryableStatus (status: number): boolean {
  return status === 429 || status >= 500
}

function isAbortError (error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isNetworkLikeFetchError (error: unknown): boolean {
  return isAbortError(error) || error instanceof TypeError
}

function runnerRequestFailureMessage (error: unknown): string {
  if (isAbortError(error)) {
    return `Agent runner service request timed out after ${runnerRequestTimeoutMs()} ms.`
  }
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}

async function sleep (ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function fetchRunnerService (url: string, init: RequestInit): Promise<Response> {
  const maxRetries = runnerRequestRetries()
  const timeoutMs = runnerRequestTimeoutMs()
  const baseDelayMs = runnerRetryBaseDelayMs()
  let last_error: unknown = null

  // Only retry transient transport failures and retryable HTTP statuses; input errors must surface immediately.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
        return response
      }
      await response.arrayBuffer().catch(() => {})
      await sleep(baseDelayMs * 2 ** attempt)
    } catch (error) {
      clearTimeout(timer)
      if (!isNetworkLikeFetchError(error) || attempt >= maxRetries) {
        throw new Error(
          `Agent runner service request failed: ${runnerRequestFailureMessage(error)}`,
          { cause: error }
        )
      }
      last_error = error
      await sleep(baseDelayMs * 2 ** attempt)
    }
  }

  throw new Error(`Agent runner service request failed: ${runnerRequestFailureMessage(last_error)}`)
}

async function readJsonResponse (response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return null
  }
  return JSON.parse(text)
}

function isRunnerServiceRunResponse (value: unknown): value is RunnerServiceQueuedResponse {
  return isRecord(value) && typeof value.status === 'string'
}

function normalizeRunnerRunStatus (value: RunnerServiceStatusResponse): RunnerRunStatus {
  return {
    run_id: value.run_id ?? null,
    workflow: value.workflow ?? null,
    status: value.status,
    ...(Object.hasOwn(value, 'result') ? { result: value.result } : {}),
    ...(value.error ? { error: value.error } : {})
  }
}

async function createRunnerRun ({
  workflow,
  request,
  service_url
}: {
  workflow: WorkflowName
  request: RunnerRequestBody
  service_url: string
}): Promise<RunnerServiceQueuedResponse> {
  const createResponse = await fetchRunnerService(`${service_url}/v1/workflows/${encodeURIComponent(workflow)}/runs`, {
    method: 'POST',
    headers: serviceHeaders(service_url),
    body: JSON.stringify(request)
  })
  const createBody = await readJsonResponse(createResponse)

  if (!createResponse.ok) {
    if (isRecord(createBody) && isRecord(createBody.error)) {
      throw buildServiceError({
        run_id: typeof createBody.run_id === 'string' ? createBody.run_id : request.run_id,
        workflow,
        error: createBody.error as RunnerServiceErrorBody
      })
    }
    throw new Error(`Agent runner service rejected request with HTTP ${createResponse.status}.`)
  }

  if (!isRunnerServiceRunResponse(createBody)) {
    throw new Error('Agent runner service returned an invalid run creation response.')
  }

  return createBody
}

async function fetchRunnerRunStatus ({
  run_id,
  service_url
}: {
  run_id: string
  service_url: string
}): Promise<RunnerServiceStatusResponse> {
  const statusResponse = await fetchRunnerService(`${service_url}/v1/runs/${encodeURIComponent(run_id)}`, {
    method: 'GET',
    headers: serviceHeaders(service_url)
  })
  const statusBody = await readJsonResponse(statusResponse)

  if (!statusResponse.ok) {
    if (isRecord(statusBody) && isRecord(statusBody.error)) {
      throw buildServiceError({
        run_id: typeof statusBody.run_id === 'string' ? statusBody.run_id : run_id,
        workflow: typeof statusBody.workflow === 'string' ? statusBody.workflow as WorkflowName : null,
        error: statusBody.error as RunnerServiceErrorBody
      })
    }
    throw new Error(`Agent runner service failed to fetch run ${run_id} with HTTP ${statusResponse.status}.`)
  }

  if (!isRunnerServiceRunResponse(statusBody)) {
    throw new Error('Agent runner service returned an invalid run status response.')
  }

  return statusBody
}

export async function submitRunnerRun ({
  workflow,
  run_id,
  input,
  runtime
}: {
  workflow: WorkflowName
  run_id: string
  input: JsonObject
  runtime?: JsonObject
}): Promise<SubmittedRunnerRun> {
  validateRunnerInput({ workflow, input })
  const service_url = runnerServiceUrl()
  const request = buildRunnerRequestBody({
    input,
    run_id,
    ...(runtime ? { runtime } : {})
  })
  logRunnerRequestDiagnostics({
    service_url,
    workflow,
    request
  })

  const createBody = await createRunnerRun({ workflow, request, service_url })
  return {
    run_id: createBody.run_id ?? request.run_id,
    workflow: createBody.workflow ?? workflow,
    status: createBody.status
  }
}

export async function getRunnerRunStatus ({ run_id }: { run_id: string }): Promise<RunnerRunStatus> {
  const service_url = runnerServiceUrl()
  const statusBody = await fetchRunnerRunStatus({
    run_id,
    service_url
  })
  return normalizeRunnerRunStatus(statusBody)
}

export function completedRunnerRunResult (status: RunnerRunStatus): RunnerWorkflowResponse | null {
  if (status.status !== 'succeeded' && status.status !== 'failed') {
    return null
  }

  if (status.error) {
    throw buildServiceError({
      run_id: status.run_id,
      workflow: status.workflow,
      error: status.error
    })
  }

  if (status.status === 'failed') {
    throw buildServiceError({
      run_id: status.run_id,
      workflow: status.workflow,
      error: {
        category: 'runtime',
        code: 'RUNNER_EXECUTION_FAILED',
        message: `Agent runner service completed run ${status.run_id ?? '(unknown)'} without an error body.`,
        retryable: false,
        details: {}
      }
    })
  }

  if (status.workflow === null || status.run_id === null) {
    throw new Error('Agent runner service completed run without run metadata.')
  }

  return {
    run_id: status.run_id,
    workflow: status.workflow,
    result: status.result
  }
}
