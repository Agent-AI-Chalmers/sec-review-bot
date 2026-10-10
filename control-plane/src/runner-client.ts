import { isIP } from 'node:net'

import type { ControlPlaneWorkflow, RunnerArtifactStorage } from './contracts.js'
import type { components } from './runner-api-schema.js'

type JsonObject = Record<string, unknown>

/** One run as the published contract reports it. */
type ContractRunResponse = components['schemas']['RunResponse']

/**
 * A response as parsed, before any field has been checked.
 *
 * The keys come from the contract, so a renamed or dropped field stops compiling here,
 * while the values stay unknown because JSON off the wire is unverified until the checks
 * below run.
 */
type UnvalidatedRunResponse = { [K in keyof ContractRunResponse]?: unknown }

/**
 * A response whose identity and status have been checked.
 *
 * `parseResponse` establishes these, so its return type says so instead of leaving callers
 * to re-assert what has already been verified.
 */
type ValidatedRunResponse = UnvalidatedRunResponse & {
  run_id: string
  workflow: ControlPlaneWorkflow
  status: string
}

/** The error envelope as parsed. Every field is read defensively. */
type UnvalidatedRunnerError = Partial<components['schemas']['RunnerError']>

/**
 * The statuses the runner may report.
 *
 * The values are listed once, as data, because the client checks them at runtime; the
 * assertion below ties that list to the contract so the two cannot drift.
 */
const RUNNER_STATUS_VALUES = ['queued', 'running', 'succeeded', 'failed'] as const
const RUNNER_STATUSES: ReadonlySet<string> = new Set(RUNNER_STATUS_VALUES)

type SameValues<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T
/** Fails to compile if the runtime status list and the contract disagree either way. */
export type StatusesMatchTheContract = Expect<
  SameValues<(typeof RUNNER_STATUS_VALUES)[number], ContractRunResponse['status']>
>

export const RUNNER_RUN_NOT_FOUND = 'RUNNER_RUN_NOT_FOUND'

export interface RunnerRunStatus extends Omit<
  ContractRunResponse,
  'run_id' | 'workflow' | 'status' | 'error' | 'artifact_storage'
> {
  run_id: string
  workflow: ControlPlaneWorkflow
  status: string
  error?: UnvalidatedRunnerError
  /** Present only once `parseArtifactStorage` has accepted it. */
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
      // The literal that was just checked, not the unvalidated field it came from.
      kind: 'diagnostic_bundle',
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
  const source =
    isRecord(body) && isRecord(body.error) ? (body.error as UnvalidatedRunnerError) : {}
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
): ValidatedRunResponse {
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
  return body as unknown as ValidatedRunResponse
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

export interface RunnerRunStatusBatch {
  /** Status tokens for runs the Runner knows, in the order they were requested. */
  readonly runs: readonly RunnerRunStatusToken[]
  /** Runs the Runner has no record for, kept apart so a caller can tell them from a drop. */
  readonly missing: readonly string[]
  /** The same statuses by run id, for callers that look runs up instead of iterating. */
  readonly byRunId: ReadonlyMap<string, string>
}

/** One run's status token, as the contract defines it. */
export type RunnerRunStatusToken = components['schemas']['RunStatusToken']

/**
 * Read many run statuses in one request.
 *
 * A caller that tracks N runs otherwise issues N requests per interval, so its check
 * frequency falls exactly when the most runs are in flight.
 *
 * There is deliberately no option to wait for a change here. Waiting was tried and made
 * the Runner busier, not less: the state lives in Temporal, so holding a request open
 * means re-reading every listed workflow on a timer, which costs far more reads than the
 * polling it replaced. A wait belongs where the state lives, not in this layer.
 */
/**
 * How many run IDs one status request carries.
 *
 * The runner rejects a longer batch, so a caller tracking more runs than this has its
 * request split rather than failing. The number is the contract's `maxItems` for
 * `RunStatusQuery.run_ids`, and a test asserts the two agree: a client-side copy of a
 * contract limit is exactly the kind of value that otherwise drifts.
 */
export const RUNNER_STATUS_QUERY_LIMIT = 200

export async function getRunnerRunStatuses(
  runIds: readonly string[]
): Promise<RunnerRunStatusBatch> {
  const runs: RunnerRunStatusToken[] = []
  const missing: string[] = []
  const byRunId = new Map<string, string>()

  for (let start = 0; start < runIds.length; start += RUNNER_STATUS_QUERY_LIMIT) {
    const batch = await readRunnerRunStatuses(
      runIds.slice(start, start + RUNNER_STATUS_QUERY_LIMIT)
    )
    runs.push(...batch.runs)
    missing.push(...batch.missing)
    for (const [runId, status] of batch.byRunId) byRunId.set(runId, status)
  }

  return { runs, missing, byRunId }
}

/** One status request, within the batch size the runner accepts. */
async function readRunnerRunStatuses(runIds: readonly string[]): Promise<RunnerRunStatusBatch> {
  const { response, body, bodyParseError } = await request('/v1/runs/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_ids: [...runIds] })
  })
  if (!response.ok) throw runnerError(body, response.status)
  if (bodyParseError) {
    throw new RunnerProtocolError(
      'RUNNER_INVALID_JSON',
      'Runner returned invalid JSON for a status query.',
      { cause: bodyParseError }
    )
  }
  if (!isRecord(body) || !Array.isArray(body.runs) || !Array.isArray(body.missing)) {
    throw new RunnerProtocolError(
      'RUNNER_INVALID_RESPONSE',
      'Runner returned an invalid status query response.'
    )
  }
  const runs: RunnerRunStatusToken[] = []
  const byRunId = new Map<string, string>()
  for (const entry of body.runs) {
    if (!isRecord(entry) || typeof entry.run_id !== 'string' || typeof entry.status !== 'string') {
      throw new RunnerProtocolError(
        'RUNNER_INVALID_RESPONSE',
        'Runner returned an invalid status entry.'
      )
    }
    if (!RUNNER_STATUSES.has(entry.status)) {
      throw new RunnerProtocolError(
        'RUNNER_INVALID_STATUS',
        `Runner returned an unknown status: ${entry.status}.`
      )
    }
    runs.push({ run_id: entry.run_id, status: entry.status })
    byRunId.set(entry.run_id, entry.status)
  }
  const missing = body.missing.filter((value): value is string => typeof value === 'string')
  return { runs, missing, byRunId }
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
    ...(isRecord(parsed.error) ? { error: parsed.error as UnvalidatedRunnerError } : {}),
    ...(parsed.artifact_storage === undefined
      ? {}
      : { artifact_storage: parseArtifactStorage(parsed.artifact_storage, runId) })
  }
}
