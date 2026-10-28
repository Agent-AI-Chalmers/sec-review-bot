import crypto from 'node:crypto'

// Review Runs intentionally owns this allowlist because it decides what enters review totals.
// Keep it aligned with agents/src/sec_review_agents/runtime/agent_names.py when agents change.
export const REVIEW_AGENT_NAMES = new Set([
  'repository-discovery',
  'repository-triager',
  'issue-analyzer',
  'pull-request-analyzer',
  'repository-analyzer',
  'issue-mitigator',
  'issue-mitigator-self-check',
  'pull-request-mitigator',
  'repository-mitigator',
  'issue-verifier',
  'pull-request-verifier',
  'repository-verifier',
  'issue-single-agent',
  'repository-cvss-v4-scorer',
  'repository-delivery-planner',
  'patch-synthesizer'
])

const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_tokens'
] as const

type TokenField = (typeof TOKEN_FIELDS)[number]
export type TokenUsage = Record<TokenField, number | null>

export interface LangfuseObservation {
  id: string
  traceId: string
  metadata: Record<string, unknown>
  model?: string
  usageDetails?: Record<string, unknown>
}

export interface ExecutionStatisticsRead {
  roots: LangfuseObservation[]
  generations: LangfuseObservation[]
  excludedNonReviewRootCount: number
}

export interface ExecutionStatisticsGroup {
  agentName: string
  caseId: string | null
  deliveryId: string | null
  passKind: string | null
  passIndex: number | null
  batchIndex: number | null
  chunkId: string | null
  provider: string
  model: string | null
  modelCallCount: number
  usageReportedCallCount: number
  tokenUsage: TokenUsage
}

export interface ExecutionStatisticsSnapshot {
  observationSetHash: string
  rootTraceCount: number
  excludedNonReviewRootCount: number
  observedCallCount: number
  usageReportedCallCount: number
  usageCoverage: 'complete_for_observed_calls' | 'partial' | 'unavailable'
  tokenUsage: TokenUsage
  groups: ExecutionStatisticsGroup[]
}

interface GroupAccumulator {
  agentName: string
  caseId: string | null
  deliveryId: string | null
  passKind: string | null
  passIndex: number | null
  batchIndex: number | null
  chunkId: string | null
  provider: string
  model: string | null
  modelCallCount: number
  usageReportedCallCount: number
  sums: Record<TokenField, number>
  reported: Record<TokenField, number>
}

function emptyTokenSums(): Record<TokenField, number> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 0
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function tokenUsage(observation: LangfuseObservation): TokenUsage | null {
  const details = observation.usageDetails
  if (details === undefined) return null
  const ordinaryInput = tokenValue(details.input)
  const ordinaryOutput = tokenValue(details.output)
  const total = tokenValue(details.total)
  const cacheRead = tokenValue(details.cache_read_input_tokens)
  const cacheCreation = tokenValue(details.cache_creation_input_tokens)
  const reasoning = tokenValue(details.reasoning)
  if (
    ordinaryInput === null &&
    ordinaryOutput === null &&
    total === null &&
    cacheRead === null &&
    cacheCreation === null &&
    reasoning === null
  )
    return null

  // Langfuse usage details are mutually exclusive billing buckets. The Review Runs
  // boundary exposes OpenTelemetry-style inclusive input/output totals instead.
  const result: TokenUsage = {
    input_tokens:
      ordinaryInput === null
        ? null
        : ordinaryInput + (cacheRead ?? 0) + (cacheCreation ?? 0),
    output_tokens:
      ordinaryOutput === null ? null : ordinaryOutput + (reasoning ?? 0),
    total_tokens: total,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    reasoning_tokens: reasoning
  }
  return result
}

function tokenValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function completeTotals(
  sums: Record<TokenField, number>,
  reported: Record<TokenField, number>,
  callCount: number
): TokenUsage {
  return Object.fromEntries(
    TOKEN_FIELDS.map((field) => [
      field,
      callCount > 0 && reported[field] === callCount ? sums[field] : null
    ])
  ) as TokenUsage
}

/** Build the run snapshot from canonical LangChain generations returned by the client. */
export function aggregateExecutionStatistics(
  read: ExecutionStatisticsRead
): ExecutionStatisticsSnapshot {
  const sums = emptyTokenSums()
  const reported = emptyTokenSums()
  let usageReportedCallCount = 0
  const groups = new Map<string, GroupAccumulator>()

  for (const call of read.generations) {
    const agentName = stringValue(call.metadata.sec_review_agent) ?? 'unknown'
    const caseId = stringValue(call.metadata.sec_review_case_id)
    const deliveryId = stringValue(call.metadata.sec_review_delivery_id)
    const passKind = stringValue(call.metadata.sec_review_pass_kind)
    const passIndex = nonNegativeInteger(call.metadata.sec_review_pass_index)
    const batchIndex = nonNegativeInteger(call.metadata.sec_review_batch_index)
    const chunkId = stringValue(call.metadata.sec_review_chunk_id)
    const provider = stringValue(call.metadata.ls_provider) ?? 'unknown'
    const model =
      stringValue(call.model) ?? stringValue(call.metadata.ls_model_name)
    const key = JSON.stringify([
      agentName,
      caseId,
      deliveryId,
      passKind,
      passIndex,
      batchIndex,
      chunkId,
      provider,
      model
    ])
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        agentName,
        caseId,
        deliveryId,
        passKind,
        passIndex,
        batchIndex,
        chunkId,
        provider,
        model,
        modelCallCount: 0,
        usageReportedCallCount: 0,
        sums: emptyTokenSums(),
        reported: emptyTokenSums()
      }
      groups.set(key, group)
    }
    group.modelCallCount += 1
    const usage = tokenUsage(call)
    if (usage !== null) {
      usageReportedCallCount += 1
      group.usageReportedCallCount += 1
      for (const field of TOKEN_FIELDS) {
        const value = usage[field]
        if (value === null) continue
        sums[field] += value
        reported[field] += 1
        group.sums[field] += value
        group.reported[field] += 1
      }
    }
  }

  const observedCallCount = read.generations.length
  // This only describes calls returned by Langfuse. The store separately refuses to interpret
  // an empty root set as proof of zero calls, because the producer may not be exporting.
  const usageCoverage =
    usageReportedCallCount === observedCallCount
      ? 'complete_for_observed_calls'
      : 'partial'
  const sortedGroups = [...groups.values()]
    .sort((left, right) =>
      [
        left.caseId ?? '',
        left.deliveryId ?? '',
        left.passIndex ?? -1,
        left.batchIndex ?? -1,
        left.chunkId ?? '',
        left.agentName,
        left.provider,
        left.model ?? ''
      ]
        .join('\0')
        .localeCompare(
          [
            right.caseId ?? '',
            right.deliveryId ?? '',
            right.passIndex ?? -1,
            right.batchIndex ?? -1,
            right.chunkId ?? '',
            right.agentName,
            right.provider,
            right.model ?? ''
          ].join('\0')
        )
    )
    .map<ExecutionStatisticsGroup>((group) => ({
      agentName: group.agentName,
      caseId: group.caseId,
      deliveryId: group.deliveryId,
      passKind: group.passKind,
      passIndex: group.passIndex,
      batchIndex: group.batchIndex,
      chunkId: group.chunkId,
      provider: group.provider,
      model: group.model,
      modelCallCount: group.modelCallCount,
      usageReportedCallCount: group.usageReportedCallCount,
      tokenUsage: completeTotals(
        group.sums,
        group.reported,
        group.modelCallCount
      )
    }))
  const totals = completeTotals(sums, reported, observedCallCount)
  const fingerprint = {
    rootIds: read.roots.map(({ id }) => id).sort(),
    generationIds: read.generations.map(({ id }) => id).sort(),
    totals,
    groups: sortedGroups
  }

  return {
    observationSetHash: crypto
      .createHash('sha256')
      .update(JSON.stringify(fingerprint))
      .digest('hex'),
    rootTraceCount: read.roots.length,
    excludedNonReviewRootCount: read.excludedNonReviewRootCount,
    observedCallCount,
    usageReportedCallCount,
    usageCoverage,
    tokenUsage: totals,
    groups: sortedGroups
  }
}
