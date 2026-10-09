import { isIP } from 'node:net'

import type { ControlPlaneWorkflow, RunnerArtifactStorage } from './contracts.js'

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
  artifact_storage?: unknown
}

const RUNNER_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed'])

export const RUNNER_RUN_NOT_FOUND = 'RUNNER_RUN_NOT_FOUND'
export interface RunnerRunStatus {
  run_id: string
  workflow: ControlPlaneWorkflow
  status: string
  result?: unknown
  error?: RunnerErrorBody
  artifact_storage?: RunnerArtifactStorage
}
export interface AgentRunnerServiceError extends Error {
  name: 'AgentRunnerServiceError'
  code: string
  retryable: boolean
}

export class RunnerProtocolError extends Error {
  readonly code: string
  readonly retryable = false

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RunnerProtocolError'
    this.code = code
  }
}

export function isTerminalRunnerPollingError(error: unknown): boolean {
  return (
    error instanceof RunnerProtocolError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'AgentRunnerServiceError' &&
      (('retryable' in error && error.retryable === false) ||
        ('code' in error && error.code === RUNNER_RUN_NOT_FOUND)))
  )
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

function parseArtifactStorage(value: unknown, runId: string): RunnerArtifactStorage {
  if (!isRecord(value) || !['available', 'unavailable', 'failed'].includes(String(value.status)))
    throw new RunnerProtocolError(
      'RUNNER_INVALID_ARTIFACT_STORAGE',
      `Runner returned invalid artifact storage metadata for ${runId}.`
    )
  const status = value.status as RunnerArtifactStorage['status']
  if (status !== 'available') {
    if (
      Object.hasOwn(value, 'artifact') ||
      Object.keys(value).some((key) => !['status', 'error_code', 'message'].includes(key)) ||
      (value.error_code !== undefined && typeof value.error_code !== 'string') ||
      (value.message !== undefined && typeof value.message !== 'string')
    )
      throw new RunnerProtocolError(
        'RUNNER_INVALID_ARTIFACT_STORAGE',
        `Runner returned invalid artifact storage metadata for ${runId}.`
      )
    return {
      status,
      ...(typeof value.error_code === 'string' ? { error_code: value.error_code } : {}),
      ...(typeof value.message === 'string' ? { message: value.message } : {})
    }
  }
  const artifact = value.artifact
  const expectedUri = `s3://sec-review/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
  if (
    Object.keys(value).some((key) => !['status', 'artifact'].includes(key)) ||
    !isRecord(artifact) ||
    Object.keys(artifact).some(
      (key) => !['kind', 'uri', 'media_type', 'digest', 'size_bytes'].includes(key)
    ) ||
    artifact.kind !== 'diagnostic_bundle' ||
    artifact.uri !== expectedUri ||
    artifact.media_type !== 'application/zstd' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0
  )
    throw new RunnerProtocolError(
      'RUNNER_INVALID_ARTIFACT_STORAGE',
      `Runner returned invalid artifact storage metadata for ${runId}.`
    )
  return {
    status,
    artifact: {
      kind: artifact.kind,
      uri: expectedUri,
      media_type: artifact.media_type,
      digest: artifact.digest,
      size_bytes: artifact.size_bytes as number
    }
  }
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
): Promise<{ response: Response; body: unknown; bodyParseError?: SyntaxError }> {
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
      let body: unknown = null
      let bodyParseError: SyntaxError | undefined
      if (text.trim()) {
        try {
          body = JSON.parse(text)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          bodyParseError = error
        }
      }
      if (!isRetryableStatus(response.status) || attempt === retries)
        return { response, body, ...(bodyParseError ? { bodyParseError } : {}) }
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
    throw new RunnerProtocolError(
      'RUNNER_INVALID_RESPONSE',
      'Runner returned an invalid run response.'
    )
  if (!RUNNER_STATUSES.has(body.status)) {
    throw new RunnerProtocolError(
      'RUNNER_INVALID_STATUS',
      `Runner returned an unknown status: ${body.status}.`
    )
  }
  if (body.run_id !== expectedRunId)
    throw new RunnerProtocolError(
      'RUNNER_IDENTITY_MISMATCH',
      `Runner returned an unexpected run_id for ${expectedRunId}.`
    )
  if (
    !isWorkflow(body.workflow) ||
    (expectedWorkflow !== undefined && body.workflow !== expectedWorkflow)
  ) {
    throw new RunnerProtocolError(
      'RUNNER_WORKFLOW_MISMATCH',
      `Runner returned an unexpected workflow for ${expectedRunId}.`
    )
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
  let result: { response: Response; body: unknown; bodyParseError?: SyntaxError }
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
    if (result.bodyParseError) throw result.bodyParseError
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
  const { response, body, bodyParseError } = await request(
    `/v1/runs/${encodeURIComponent(runId)}`,
    { method: 'GET' }
  )
  if (!response.ok) throw runnerError(body, response.status)
  if (bodyParseError) {
    throw new RunnerProtocolError(
      'RUNNER_INVALID_JSON',
      `Runner returned invalid JSON for ${runId}.`,
      { cause: bodyParseError }
    )
  }
  const parsed = parseResponse(body, runId, workflow)
  return {
    run_id: runId,
    workflow: parsed.workflow as ControlPlaneWorkflow,
    status: parsed.status,
    ...(Object.hasOwn(parsed, 'result') ? { result: parsed.result } : {}),
    ...(isRecord(parsed.error) ? { error: parsed.error as RunnerErrorBody } : {}),
    ...(parsed.artifact_storage === undefined
      ? {}
      : { artifact_storage: parseArtifactStorage(parsed.artifact_storage, runId) })
  }
}
