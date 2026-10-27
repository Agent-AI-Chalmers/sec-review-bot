import {
  REVIEW_AGENT_NAMES,
  type ExecutionStatisticsRead,
  type LangfuseObservation
} from './execution-statistics.js'

const OBSERVATIONS_V2_PATH = '/api/public/v2/observations'
const LANGFUSE_SDK_INSTRUMENTATION_SCOPE = 'langfuse-sdk'

export class LangfuseRateLimitError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super('Langfuse observations request was rate limited.')
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) return Number(value) * 1_000
  const instant = Date.parse(value)
  return Number.isNaN(instant) ? null : Math.max(0, instant - Date.now())
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseObservation(value: unknown, index: number): LangfuseObservation {
  const item = objectValue(value)
  if (item === null)
    throw new Error(`Langfuse observation data[${index}] is not an object.`)
  if (typeof item.id !== 'string' || item.id === '')
    throw new Error(`Langfuse observation data[${index}] has no id.`)
  const traceId = item.traceId
  if (typeof traceId !== 'string' || traceId === '')
    throw new Error(`Langfuse observation ${item.id} has no traceId.`)
  const metadataValue = item.metadata
  const parsedMetadata = objectValue(metadataValue)
  if (
    metadataValue !== undefined &&
    metadataValue !== null &&
    parsedMetadata === null
  )
    throw new Error(`Langfuse observation ${item.id} has invalid metadata.`)
  const metadata = parsedMetadata ?? {}
  const observation: LangfuseObservation = { id: item.id, traceId, metadata }
  if (item.model !== undefined && item.model !== null) {
    if (typeof item.model !== 'string')
      throw new Error(`Langfuse observation ${item.id} has invalid model.`)
    observation.model = item.model
  }
  const usageDetails = objectValue(item.usageDetails)
  if (item.usageDetails !== undefined && item.usageDetails !== null) {
    if (usageDetails === null)
      throw new Error(
        `Langfuse observation ${item.id} has invalid usageDetails.`
      )
    observation.usageDetails = usageDetails
  }
  return observation
}

export class LangfuseObservationsClient {
  private readonly authorization: string

  constructor(
    private readonly baseUrl: string,
    publicKey: string,
    secretKey: string,
    private readonly timeoutMs: number
  ) {
    this.authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
  }

  private async readPages(
    parameters: Readonly<Record<string, string>>
  ): Promise<LangfuseObservation[]> {
    const observations = new Map<string, LangfuseObservation>()
    let cursor: string | undefined
    do {
      const url = new URL(OBSERVATIONS_V2_PATH, this.baseUrl)
      for (const [name, value] of Object.entries(parameters))
        url.searchParams.set(name, value)
      url.searchParams.set('limit', '1000')
      if (cursor !== undefined) url.searchParams.set('cursor', cursor)
      const response = await fetch(url, {
        headers: { authorization: this.authorization },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (response.status === 429)
        throw new LangfuseRateLimitError(retryAfterMs(response))
      if (!response.ok) {
        throw new Error(
          `Langfuse observations request failed with HTTP ${response.status}.`
        )
      }
      const body = objectValue(await response.json())
      const data = body?.data
      const meta = objectValue(body?.meta)
      if (!Array.isArray(data) || meta === null)
        throw new Error('Langfuse observations response has an invalid shape.')
      for (const [index, value] of data.entries()) {
        const observation = parseObservation(value, index)
        observations.set(observation.id, observation)
      }
      const nextCursor = meta.cursor
      if (
        nextCursor === undefined ||
        nextCursor === null ||
        nextCursor === ''
      ) {
        cursor = undefined
      } else if (typeof nextCursor === 'string') {
        cursor = nextCursor
      } else {
        throw new Error('Langfuse observations response has an invalid cursor.')
      }
    } while (cursor !== undefined)
    return [...observations.values()]
  }

  /** Read review-agent roots for one run and canonical LangChain generations below them. */
  async readRun({
    runId,
    fromStartTime,
    toStartTime
  }: {
    runId: string
    fromStartTime: string
    toStartTime: string
  }): Promise<ExecutionStatisticsRead> {
    const candidateRoots = await this.readPages({
      fields: 'basic,metadata',
      sessionId: runId,
      isRootObservation: 'true',
      fromStartTime,
      toStartTime
    })
    const roots = candidateRoots.filter((root) =>
      REVIEW_AGENT_NAMES.has(root.metadata.sec_review_agent as string)
    )
    const rootAgentByTraceId = new Map(
      roots.map((root) => [root.traceId, root.metadata.sec_review_agent])
    )
    const generations = new Map<string, LangfuseObservation>()
    // Query the session once instead of once per root. Pagination still scales with the number
    // of observations, but agent invocations do not multiply Langfuse request count.
    const calls = await this.readPages({
      fields: 'basic,time,metadata,model,usage',
      sessionId: runId,
      type: 'GENERATION',
      fromStartTime,
      toStartTime
    })
    for (const call of calls) {
      const agentName =
        call.metadata.sec_review_agent ?? rootAgentByTraceId.get(call.traceId)
      if (typeof agentName !== 'string' || !REVIEW_AGENT_NAMES.has(agentName)) {
        continue
      }
      call.metadata.sec_review_agent = agentName
      // The producer suppresses provider-SDK duplicates before export. Seeing one here means
      // that invariant regressed; failing the read is safer than silently changing the bill.
      if (call.metadata['scope.name'] !== LANGFUSE_SDK_INSTRUMENTATION_SCOPE) {
        throw new Error(
          `Review generation ${call.id} has unexpected instrumentation scope.`
        )
      }
      generations.set(call.id, call)
    }
    return {
      roots,
      generations: [...generations.values()],
      excludedNonReviewRootCount: candidateRoots.length - roots.length
    }
  }
}
