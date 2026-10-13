import type { components, paths } from './control-plane-api.js'
import { parsePublishContextForWorkflow, type PublishContext } from './publish-context.js'

export type ReviewRunRecord = components['schemas']['ReviewRunRecord']
export type ReviewRunAdmission = components['schemas']['ReviewRunAdmission']
export type PublicationWork = components['schemas']['PublicationWork']
export type PublicationStepRecord = components['schemas']['PublicationStepRecord']

type JsonObject = Record<string, unknown>

/** A contract path template, e.g. `/v1/runs/{runId}/submission`. */
type ContractPath = keyof paths

/** The `{param}` names a path template declares, as a union. */
type PathParam<T extends string> = T extends `${string}{${infer P}}${infer Rest}`
  ? P | PathParam<Rest>
  : never

/** Build a request URL from the contract's own path template, so a renamed path in
 * `openapi.yaml` fails to compile here instead of silently calling a stale URL — the drift
 * the generated `paths` type exists to prevent. The parameter names are checked too. */
function contractPath<T extends ContractPath>(
  template: T,
  params: Record<PathParam<T>, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = (params as Record<string, string | undefined>)[name]
    if (value === undefined) throw new Error(`Missing path parameter ${name} for ${template}`)
    return encodeURIComponent(value)
  })
}

export class ControlPlaneSubmissionError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'ControlPlaneSubmissionError'
    this.code = code
  }
}

function serviceUrl(): string {
  const value = process.env.CONTROL_PLANE_SERVICE_URL?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_URL is required.')
  return value.replace(/\/+$/, '')
}

function serviceToken(): string {
  const value = process.env.CONTROL_PLANE_SERVICE_TOKEN?.trim()
  if (!value) throw new Error('CONTROL_PLANE_SERVICE_TOKEN is required.')
  return value
}

function requestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CONTROL_PLANE_REQUEST_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

/** The REST error envelope: `{ error: string, code?: string }` (HTTP 400/404/409/500). */
interface HttpErrorBody {
  error?: string
  code?: string
}

class HttpControlPlaneClient {
  readonly connectorId = process.env.CONNECTOR_ID?.trim() || 'github-app:default'

  // One HTTP request with auth, timeout, and error/status handling. `nullOn404` maps a 404
  // to `null` for reads that distinguish "absent" from "error".
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    nullOn404 = false
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs())
    timeout.unref?.()
    try {
      const response = await fetch(`${serviceUrl()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${serviceToken()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      })
      if (!response.ok) {
        if (nullOn404 && response.status === 404) return null as T
        const parsed = (await response.json().catch(() => ({}))) as HttpErrorBody
        throw Object.assign(
          new Error(parsed.error ?? `Control Plane returned HTTP ${response.status}.`),
          { code: parsed.code ?? null }
        )
      }
      return (await response.json()) as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw Object.assign(new Error(`Control Plane ${method} ${path} timed out.`), {
          code: 'CONTROL_PLANE_REQUEST_TIMEOUT',
          cause: error
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async validateContext(runId: string, context: PublishContext): Promise<PublishContext> {
    const run = await this.getRun(runId)
    if (run === null) throw new Error(`Control Plane run does not exist: ${runId}`)
    return parsePublishContextForWorkflow(run.workflow, context)
  }

  // Admission deliberately persists an empty context: run identity exists before input
  // preparation discovers the workflow-specific publish target. Control Plane owns the run
  // id, so `run_id` is omitted here and returned on `record`.
  async admitReviewRun(run: {
    workflow: 'issue-review' | 'pull-request-review' | 'repository-review'
    publish_context: JsonObject
    runner_input?: JsonObject
    ingress_kind: 'github_webhook' | 'github_actions_dispatch'
    ingress_key: string
  }): Promise<ReviewRunAdmission> {
    return await this.request<ReviewRunAdmission>('POST', contractPath('/v1/runs', {}), run)
  }

  async submitPreparedRun(
    runId: string,
    token: string,
    context: PublishContext,
    input: JsonObject
  ): Promise<void> {
    const publishContext = await this.validateContext(runId, context)
    try {
      await this.request('POST', contractPath('/v1/runs/{runId}/submission', { runId }), {
        preparation_token: token,
        publish_context: publishContext,
        input
      })
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : null
      throw new ControlPlaneSubmissionError(
        error instanceof Error ? error.message : String(error),
        code
      )
    }
  }

  // Status queries must expose preparing runs whose publish context is not ready.
  // Publication claims below remain the strict persisted-context boundary.
  async getRun(runId: string): Promise<ReviewRunRecord | null> {
    return await this.request<ReviewRunRecord>(
      'GET',
      contractPath('/v1/internal/runs/{runId}', { runId }),
      undefined,
      true
    )
  }

  async renewPreparationClaim(runId: string, token: string): Promise<boolean> {
    return await this.request<boolean>(
      'POST',
      contractPath('/v1/runs/{runId}/preparation/claim', { runId }),
      { token }
    )
  }

  async preparationHeartbeatIntervalMs(): Promise<number> {
    return await this.request<number>(
      'GET',
      contractPath('/v1/config/preparation-heartbeat-interval', {})
    )
  }

  /**
   * Claim the next publishable run, optionally asking Control Plane to hold the request
   * until one appears. The wait is served where the state lives, so it costs Control Plane
   * one indexed query per tick instead of a request per poll interval.
   */
  async claimNextPublication(waitMs = 0): Promise<PublicationWork | null> {
    const work = await this.request<PublicationWork | null>(
      'POST',
      contractPath('/v1/publication/claims/next', {}),
      {
        wait_ms: waitMs
      }
    )
    if (work === null) return null
    try {
      return {
        ...work,
        publish_context: parsePublishContextForWorkflow(work.workflow, work.publish_context)
      }
    } catch (error) {
      // Validation happens after the durable claim because connector-specific context does
      // not belong in Control Plane. A corrupt record must still consume that claim into a
      // terminal failure instead of timing out forever.
      await this.failPublication(
        work.run_id,
        work.claim_token,
        {
          code:
            error instanceof Error && 'code' in error && typeof error.code === 'string'
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
    return await this.request<boolean>(
      'POST',
      contractPath('/v1/runs/{runId}/publication/claim', { runId }),
      { token }
    )
  }

  async publicationHeartbeatIntervalMs(): Promise<number> {
    return await this.request<number>(
      'GET',
      contractPath('/v1/config/publication-heartbeat-interval', {})
    )
  }

  async initializePublicationSteps(
    runId: string,
    token: string,
    stepKeys: string[]
  ): Promise<void> {
    await this.request('POST', contractPath('/v1/runs/{runId}/publication/steps', { runId }), {
      token,
      step_keys: stepKeys
    })
  }

  async listPublicationSteps(runId: string): Promise<PublicationStepRecord[]> {
    return await this.request<PublicationStepRecord[]>(
      'GET',
      contractPath('/v1/internal/runs/{runId}/publication/steps', { runId })
    )
  }

  async requirePublicationStepClaim(runId: string, token: string, stepKey: string): Promise<void> {
    await this.request(
      'POST',
      contractPath('/v1/runs/{runId}/publication/steps/{stepKey}/claim', { runId, stepKey }),
      { token }
    )
  }

  async completePublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    remote: { id?: string | number | null; url?: string | null } = {}
  ): Promise<boolean> {
    return await this.request<boolean>(
      'POST',
      contractPath('/v1/runs/{runId}/publication/steps/{stepKey}/complete', { runId, stepKey }),
      { token, remote_object: remote }
    )
  }

  async failPublicationStep(
    runId: string,
    token: string,
    stepKey: string,
    failure: { code?: string | null; message: string },
    options: { retry?: boolean } = {}
  ): Promise<boolean> {
    return await this.request<boolean>(
      'POST',
      contractPath('/v1/runs/{runId}/publication/steps/{stepKey}/fail', { runId, stepKey }),
      { token, failure, ...(options.retry === undefined ? {} : { retry: options.retry }) }
    )
  }

  async completePublication(runId: string, token: string): Promise<boolean> {
    return await this.request<boolean>(
      'POST',
      contractPath('/v1/runs/{runId}/publication/complete', { runId }),
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
    return await this.request<boolean>(
      'POST',
      contractPath('/v1/runs/{runId}/publication/fail', { runId }),
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
    failure: { code?: string | null; message: string }
  ): Promise<void> {
    await this.request('POST', contractPath('/v1/runs/{runId}/preparation/failure', { runId }), {
      token,
      failure
    })
  }
}

export type ControlPlaneClient = Pick<
  HttpControlPlaneClient,
  | 'connectorId'
  | 'admitReviewRun'
  | 'submitPreparedRun'
  | 'getRun'
  | 'renewPreparationClaim'
  | 'preparationHeartbeatIntervalMs'
  | 'renewPublicationClaim'
  | 'publicationHeartbeatIntervalMs'
  | 'claimNextPublication'
  | 'initializePublicationSteps'
  | 'listPublicationSteps'
  | 'requirePublicationStepClaim'
  | 'completePublicationStep'
  | 'failPublicationStep'
  | 'completePublication'
  | 'failPublication'
  | 'failPreparation'
>

export const controlPlaneClient: ControlPlaneClient = new HttpControlPlaneClient()
