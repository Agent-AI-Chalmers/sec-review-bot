import { isIP } from 'node:net'
import { TextDecoder } from 'node:util'

import { integerEnv } from './env.js'

import type {
  ReviewRunWorkflow,
  ExecutionArtifactStorage
} from './contracts.js'
import type {
  ExecutionError,
  RunResponse,
  RunStatusToken
} from './execution-api-schema.js'
import { SUBMISSION_STATE_UNCERTAIN } from './errors.js'

type JsonObject = Record<string, unknown>

const MAX_EXECUTION_RESPONSE_BYTES = 4 * 1024 * 1024

/** One run as the published contract reports it. */
type ContractRunResponse = RunResponse

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
  workflow: ReviewRunWorkflow
  status: string
}

/** The error envelope as parsed. Every field is read defensively. */
type UnvalidatedExecutionError = Partial<ExecutionError>

/**
 * The statuses the Execution API may report.
 *
 * The values are listed once, as data, because the client checks them at runtime; the
 * assertion below ties that list to the contract so the two cannot drift.
 */
const EXECUTION_STATUS_VALUES = [
  'queued',
  'running',
  'succeeded',
  'failed'
] as const
const EXECUTION_STATUSES: ReadonlySet<string> = new Set(EXECUTION_STATUS_VALUES)

type SameValues<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false
type Expect<T extends true> = T
/** Fails to compile if the runtime status list and the contract disagree either way. */
export type StatusesMatchTheContract = Expect<
  SameValues<
    (typeof EXECUTION_STATUS_VALUES)[number],
    ContractRunResponse['status']
  >
>

export const EXECUTION_RUN_NOT_FOUND = 'EXECUTION_RUN_NOT_FOUND'

export interface ExecutionRunStatus extends Omit<
  ContractRunResponse,
  'run_id' | 'workflow' | 'status' | 'error' | 'artifact_storage'
> {
  run_id: string
  workflow: ReviewRunWorkflow
  status: string
  error?: UnvalidatedExecutionError
  /** Present only once `parseArtifactStorage` has accepted it. */
  artifact_storage?: ExecutionArtifactStorage
}
export interface ExecutionServiceError extends Error {
  name: 'ExecutionServiceError'
  code: string
  retryable: boolean
}

export class ExecutionProtocolError extends Error {
  readonly code: string
  readonly retryable = false

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExecutionProtocolError'
    this.code = code
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_EXECUTION_RESPONSE_BYTES
  ) {
    await response.body?.cancel()
    throw new ExecutionProtocolError(
      'EXECUTION_RESPONSE_TOO_LARGE',
      'Execution returned a response larger than the protocol budget.'
    )
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
      if (size > MAX_EXECUTION_RESPONSE_BYTES) {
        await reader.cancel()
        throw new ExecutionProtocolError(
          'EXECUTION_RESPONSE_TOO_LARGE',
          'Execution returned a response larger than the protocol budget.'
        )
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

export function isTerminalExecutionPollingError(error: unknown): boolean {
  return (
    error instanceof ExecutionProtocolError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'ExecutionServiceError' &&
      (('retryable' in error && error.retryable === false) ||
        ('code' in error && error.code === EXECUTION_RUN_NOT_FOUND)))
  )
}

export class ExecutionSubmissionUncertainError extends Error {
  readonly code = SUBMISSION_STATE_UNCERTAIN

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExecutionSubmissionUncertainError'
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkflow(value: unknown): value is ReviewRunWorkflow {
  return (
    value === 'issue-review' ||
    value === 'pull-request-review' ||
    value === 'repository-review'
  )
}

function parseArtifactStorage(
  value: unknown,
  runId: string
): ExecutionArtifactStorage {
  if (
    !isRecord(value) ||
    !['available', 'unavailable', 'failed'].includes(String(value.status))
  )
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_ARTIFACT_STORAGE',
      `Execution returned invalid artifact storage metadata for ${runId}.`
    )
  const status = value.status as ExecutionArtifactStorage['status']
  if (status !== 'available') {
    if (
      Object.hasOwn(value, 'artifact') ||
      Object.keys(value).some(
        (key) => !['status', 'error_code', 'message'].includes(key)
      ) ||
      (value.error_code !== undefined &&
        typeof value.error_code !== 'string') ||
      (value.message !== undefined && typeof value.message !== 'string')
    )
      throw new ExecutionProtocolError(
        'EXECUTION_INVALID_ARTIFACT_STORAGE',
        `Execution returned invalid artifact storage metadata for ${runId}.`
      )
    return {
      status,
      ...(typeof value.error_code === 'string'
        ? { error_code: value.error_code }
        : {}),
      ...(typeof value.message === 'string' ? { message: value.message } : {})
    }
  }
  const artifact = value.artifact
  const artifactUri =
    typeof artifact === 'object' && artifact !== null && 'uri' in artifact
      ? parseDiagnosticArtifactUri(artifact.uri, runId)
      : undefined
  if (
    Object.keys(value).some((key) => !['status', 'artifact'].includes(key)) ||
    !isRecord(artifact) ||
    Object.keys(artifact).some(
      (key) =>
        !['kind', 'uri', 'media_type', 'digest', 'size_bytes'].includes(key)
    ) ||
    artifact.kind !== 'diagnostic_bundle' ||
    artifactUri === undefined ||
    artifact.media_type !== 'application/tar+zstd' ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_bytes) ||
    (artifact.size_bytes as number) < 0
  )
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_ARTIFACT_STORAGE',
      `Execution returned invalid artifact storage metadata for ${runId}.`
    )
  return {
    status,
    artifact: {
      // The literal that was just checked, not the unvalidated field it came from.
      kind: 'diagnostic_bundle',
      uri: artifactUri,
      media_type: artifact.media_type,
      digest: artifact.digest,
      size_bytes: artifact.size_bytes as number
    }
  }
}

function parseDiagnosticArtifactUri(
  value: unknown,
  runId: string
): string | undefined {
  if (typeof value !== 'string') return undefined
  let uri: URL
  try {
    uri = new URL(value)
  } catch {
    return undefined
  }
  if (
    uri.protocol !== 's3:' ||
    uri.hostname === '' ||
    uri.username !== '' ||
    uri.password !== '' ||
    uri.port !== '' ||
    uri.search !== '' ||
    uri.hash !== '' ||
    uri.pathname !== `/runs/${runId}/artifacts/diagnostic-tree.v1.tar.zst`
  )
    return undefined
  return value
}

function serviceUrl(): string {
  const value = process.env.EXECUTION_API_URL?.trim()
  if (!value)
    throw Object.assign(new Error('EXECUTION_API_URL is required.'), {
      code: 'EXECUTION_API_URL_MISSING'
    })
  return value.replace(/\/+$/, '')
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const value =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
  return (
    (isIP(value) === 4 && value.split('.')[0] === '127') ||
    (isIP(value) === 6 && value === '::1')
  )
}

function serviceHeaders(url: string): Record<string, string> {
  const token = process.env.EXECUTION_API_TOKEN?.trim()
  const parsed = new URL(url)
  if (!token && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw Object.assign(
      new Error(
        'EXECUTION_API_TOKEN is required unless the Execution API uses loopback HTTP.'
      ),
      { code: 'EXECUTION_API_TOKEN_MISSING' }
    )
  }
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  }
}

function executionError(body: unknown, status: number): ExecutionServiceError {
  const source =
    isRecord(body) && isRecord(body.error)
      ? (body.error as UnvalidatedExecutionError)
      : {}
  return Object.assign(
    new Error(source.message ?? `Execution returned HTTP ${status}.`),
    {
      name: 'ExecutionServiceError' as const,
      code: source.code ?? 'EXECUTION_API_ERROR',
      retryable: source.retryable ?? (status === 429 || status >= 500)
    }
  )
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function isTransientTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

async function request(
  path: string,
  init: RequestInit
): Promise<{
  response: Response
  body: unknown
  bodyParseError?: SyntaxError | ExecutionProtocolError
}> {
  const base = serviceUrl()
  const retries = integerEnv('EXECUTION_API_REQUEST_RETRIES', 2, 0)
  const timeout = integerEnv('EXECUTION_API_REQUEST_TIMEOUT_MS', 30_000)
  const delay = integerEnv('EXECUTION_API_RETRY_BASE_DELAY_MS', 500)
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
      let text = ''
      let body: unknown = null
      let bodyParseError: SyntaxError | ExecutionProtocolError | undefined
      try {
        text = await readBoundedResponseText(response)
      } catch (error) {
        if (!(error instanceof ExecutionProtocolError)) throw error
        bodyParseError = error
      }
      if (bodyParseError === undefined && text.trim()) {
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
  expectedWorkflow?: ReviewRunWorkflow
): ValidatedRunResponse {
  if (!isRecord(body) || typeof body.status !== 'string')
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_RESPONSE',
      'Execution returned an invalid run response.'
    )
  if (!EXECUTION_STATUSES.has(body.status)) {
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_STATUS',
      `Execution returned an unknown status: ${body.status}.`
    )
  }
  if (body.run_id !== expectedRunId)
    throw new ExecutionProtocolError(
      'EXECUTION_IDENTITY_MISMATCH',
      `Execution returned an unexpected run_id for ${expectedRunId}.`
    )
  if (
    !isWorkflow(body.workflow) ||
    (expectedWorkflow !== undefined && body.workflow !== expectedWorkflow)
  ) {
    throw new ExecutionProtocolError(
      'EXECUTION_WORKFLOW_MISMATCH',
      `Execution returned an unexpected workflow for ${expectedRunId}.`
    )
  }
  return body as unknown as ValidatedRunResponse
}

export async function submitExecutionRun({
  workflow,
  run_id,
  input
}: {
  workflow: ReviewRunWorkflow
  run_id: string
  input: JsonObject
}): Promise<void> {
  let result: {
    response: Response
    body: unknown
    bodyParseError?: SyntaxError | ExecutionProtocolError
  }
  try {
    result = await request(
      `/v1/workflows/${encodeURIComponent(workflow)}/runs`,
      {
        method: 'POST',
        body: JSON.stringify({ run_id, input })
      }
    )
  } catch (error) {
    throw new ExecutionSubmissionUncertainError(
      `Execution submission state is uncertain for run ${run_id}.`,
      { cause: error }
    )
  }
  if (!result.response.ok) {
    if (isRetryableStatus(result.response.status)) {
      throw new ExecutionSubmissionUncertainError(
        `Execution submission returned HTTP ${result.response.status} for run ${run_id}.`
      )
    }
    throw executionError(result.body, result.response.status)
  }
  try {
    if (result.bodyParseError) throw result.bodyParseError
    parseResponse(result.body, run_id, workflow)
  } catch (error) {
    throw new ExecutionSubmissionUncertainError(
      `Execution accepted run ${run_id}, but returned an invalid creation response.`,
      { cause: error }
    )
  }
}

export interface ExecutionRunStatusBatch {
  /** Status tokens for runs the Execution knows, in the order they were requested. */
  readonly runs: readonly ExecutionRunStatusToken[]
  /** Runs the Execution has no record for, kept apart so a caller can tell them from a drop. */
  readonly missing: readonly string[]
  /** The same statuses by run id, for callers that look runs up instead of iterating. */
  readonly byRunId: ReadonlyMap<string, string>
}

/** One run's status token, as the contract defines it. */
export type ExecutionRunStatusToken = RunStatusToken

/**
 * How many run IDs one status request carries.
 *
 * The Execution API rejects a longer batch, so a caller tracking more runs than this has its
 * request split rather than failing. The number is the contract's `maxItems` for
 * `RunStatusQuery.run_ids`, and a test asserts the two agree: a client-side copy of a
 * contract limit is exactly the kind of value that otherwise drifts.
 */
export const EXECUTION_STATUS_QUERY_LIMIT = 200

/**
 * Read many run statuses in one request.
 *
 * A caller that tracks N runs otherwise issues N requests per interval, so its check
 * frequency falls exactly when the most runs are in flight.
 *
 * There is deliberately no option to wait for a change here. Waiting was tried and made
 * the Execution busier, not less: the state lives in Temporal, so holding a request open
 * means re-reading every listed workflow on a timer, which costs far more reads than the
 * polling it replaced. A wait belongs where the state lives, not in this layer.
 */

export async function getExecutionRunStatuses(
  runIds: readonly string[]
): Promise<ExecutionRunStatusBatch> {
  const runs: ExecutionRunStatusToken[] = []
  const missing: string[] = []
  const byRunId = new Map<string, string>()

  for (
    let start = 0;
    start < runIds.length;
    start += EXECUTION_STATUS_QUERY_LIMIT
  ) {
    const batch = await readExecutionRunStatuses(
      runIds.slice(start, start + EXECUTION_STATUS_QUERY_LIMIT)
    )
    runs.push(...batch.runs)
    missing.push(...batch.missing)
    for (const [runId, status] of batch.byRunId) byRunId.set(runId, status)
  }

  return { runs, missing, byRunId }
}

/** One status request, within the batch size the Execution API accepts. */
async function readExecutionRunStatuses(
  runIds: readonly string[]
): Promise<ExecutionRunStatusBatch> {
  const { response, body, bodyParseError } = await request('/v1/runs/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_ids: [...runIds] })
  })
  if (!response.ok) throw executionError(body, response.status)
  if (bodyParseError) {
    if (bodyParseError instanceof ExecutionProtocolError) throw bodyParseError
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_JSON',
      'Execution returned invalid JSON for a status query.',
      { cause: bodyParseError }
    )
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body.runs) ||
    !Array.isArray(body.missing)
  ) {
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_RESPONSE',
      'Execution returned an invalid status query response.'
    )
  }
  const runs: ExecutionRunStatusToken[] = []
  const byRunId = new Map<string, string>()
  for (const entry of body.runs) {
    if (
      !isRecord(entry) ||
      typeof entry.run_id !== 'string' ||
      typeof entry.status !== 'string'
    ) {
      throw new ExecutionProtocolError(
        'EXECUTION_INVALID_RESPONSE',
        'Execution returned an invalid status entry.'
      )
    }
    if (!EXECUTION_STATUSES.has(entry.status)) {
      throw new ExecutionProtocolError(
        'EXECUTION_INVALID_STATUS',
        `Execution returned an unknown status: ${entry.status}.`
      )
    }
    runs.push({ run_id: entry.run_id, status: entry.status })
    byRunId.set(entry.run_id, entry.status)
  }
  const missing = body.missing.filter(
    (value): value is string => typeof value === 'string'
  )
  return { runs, missing, byRunId }
}

export async function getExecutionRunStatus(
  runId: string,
  workflow?: ReviewRunWorkflow
): Promise<ExecutionRunStatus> {
  const { response, body, bodyParseError } = await request(
    `/v1/runs/${encodeURIComponent(runId)}`,
    { method: 'GET' }
  )
  if (!response.ok) throw executionError(body, response.status)
  if (bodyParseError) {
    if (bodyParseError instanceof ExecutionProtocolError) throw bodyParseError
    throw new ExecutionProtocolError(
      'EXECUTION_INVALID_JSON',
      `Execution returned invalid JSON for ${runId}.`,
      { cause: bodyParseError }
    )
  }
  const parsed = parseResponse(body, runId, workflow)
  return {
    run_id: runId,
    workflow: parsed.workflow as ReviewRunWorkflow,
    status: parsed.status,
    ...(Object.hasOwn(parsed, 'result') ? { result: parsed.result } : {}),
    ...(isRecord(parsed.memory_processing)
      ? { memory_processing: parsed.memory_processing }
      : {}),
    ...(isRecord(parsed.error)
      ? { error: parsed.error as UnvalidatedExecutionError }
      : {}),
    ...(parsed.artifact_storage === undefined
      ? {}
      : {
          artifact_storage: parseArtifactStorage(parsed.artifact_storage, runId)
        })
  }
}
