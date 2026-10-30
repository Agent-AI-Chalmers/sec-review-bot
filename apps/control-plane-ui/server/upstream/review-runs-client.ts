import { requestUpstream, type UpstreamResult } from './request.js'

export type RunDecision = 'abandon' | 'resume' | 'give-up'

export interface ReviewRunsClient {
  getRun(runId: string): Promise<UpstreamResult>
  read(path: string): Promise<UpstreamResult>
  decide(
    runId: string,
    action: RunDecision,
    adminToken: string,
    body: Buffer
  ): Promise<UpstreamResult>
}

/** Review Runs reads and operator decisions, with the read token owned by this client. */
export function createReviewRunsClient({
  baseUrl,
  readToken,
  requestTimeoutMs,
  maximumResponseBytes
}: {
  baseUrl: string
  readToken: string
  requestTimeoutMs: number
  maximumResponseBytes: number
}): ReviewRunsClient {
  const options = {
    timeoutMs: requestTimeoutMs,
    maximumBytes: maximumResponseBytes
  }
  const readHeaders = { authorization: `Bearer ${readToken}` }

  return {
    getRun: (runId) =>
      requestUpstream(
        `${baseUrl}/v1/runs/${encodeURIComponent(runId)}`,
        { headers: readHeaders },
        options
      ),
    read: (path) =>
      requestUpstream(
        `${baseUrl}/v1${path}`,
        { headers: readHeaders },
        options
      ),
    decide: (runId, action, adminToken, body) =>
      requestUpstream(
        `${baseUrl}/v1/admin/runs/${encodeURIComponent(runId)}/${action}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json'
          },
          body: new Uint8Array(body)
        },
        options
      )
  }
}
