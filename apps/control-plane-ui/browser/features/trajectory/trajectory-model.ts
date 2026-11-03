import type {
  TrajectoryEvent,
  TrajectoryMessageEvent
} from '../../../shared/trajectory-events.js'

export type TrajectoryRole =
  'system' | 'human' | 'assistant' | 'tool' | 'unknown'

export type { TrajectoryEvent } from '../../../shared/trajectory-events.js'

export interface ToolCallView {
  anchorId: string
  id: string
  name: string
  args: Record<string, unknown>
  resultMessageId: string | undefined
  /** Real unified diff reported by the tool, when it provides one. */
  diff?: string
  diffTruncated?: boolean
}

export interface UsageView {
  input: number | undefined
  output: number | undefined
  cacheRead: number | undefined
  cacheCreation: number | undefined
  reasoning: number | undefined
  total: number | undefined
}

export interface TrajectoryMessageView {
  id: string
  seq: number
  role: TrajectoryRole
  name: string | undefined
  agent?: string | undefined
  source?: string | undefined
  parentIds?: string[] | undefined
  modelProvider: string | undefined
  modelName: string | undefined
  content: string
  reasoning: string
  toolCalls: ToolCallView[]
  requestAnchorId?: string
  toolCallId: string | undefined
  status: string | undefined
  artifact: unknown
  diff: string | undefined
  diffTruncated: boolean | undefined
  usage: UsageView | undefined
  searchable: string
}

export interface TrajectoryDocument {
  messages: TrajectoryMessageView[]
  totalUsage: UsageView
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function role(value: unknown): TrajectoryRole {
  const kind = typeof value === 'string' ? value.toLowerCase() : ''
  if (kind === 'system') return 'system'
  if (kind === 'user') return 'human'
  if (kind === 'assistant') return 'assistant'
  if (kind === 'tool') return 'tool'
  return 'unknown'
}

function contentParts(value: unknown): { content: string; reasoning: string } {
  if (typeof value === 'string') return { content: value, reasoning: '' }
  if (!Array.isArray(value)) {
    return {
      content:
        value === null || value === undefined
          ? ''
          : JSON.stringify(value, null, 2),
      reasoning: ''
    }
  }
  const content: string[] = []
  const reasoning: string[] = []
  for (const block of value) {
    if (typeof block === 'string') {
      content.push(block)
      continue
    }
    const item = record(block)
    if (!item) {
      content.push(JSON.stringify(block, null, 2))
      continue
    }
    if (item.type === 'text' && typeof item.text === 'string')
      content.push(item.text)
    else if (item.type === 'thinking' && typeof item.thinking === 'string')
      reasoning.push(item.thinking)
    else if (item.type !== 'tool_use')
      content.push(JSON.stringify(item, null, 2))
  }
  return { content: content.join('\n\n'), reasoning: reasoning.join('\n\n') }
}

function usage(message: Record<string, unknown>): UsageView | undefined {
  const source = record(message.usage_metadata)
  if (!source) return undefined
  const cacheRead = number(source.cache_read_input_tokens)
  const cacheCreation = number(source.cache_creation_input_tokens)
  const input = number(source.input_tokens)
  const result: UsageView = {
    input,
    output: number(source.output_tokens),
    cacheRead,
    cacheCreation,
    total: number(source.total_tokens),
    reasoning: number(source.reasoning_tokens)
  }
  return Object.values(result).some((item) => item !== undefined)
    ? result
    : undefined
}

function toolCalls(
  message: Record<string, unknown>,
  seq: number
): ToolCallView[] {
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls.flatMap((value, index) => {
    const call = record(value)
    if (!call) return []
    const args = record(call.args) ?? record(call.input) ?? {}
    return [
      {
        anchorId: `trajectory-call-${seq}-${index}`,
        id:
          typeof call.id === 'string' && call.id
            ? call.id
            : `tool-call-${index + 1}`,
        name:
          typeof call.name === 'string'
            ? call.name
            : typeof call.type === 'string'
              ? call.type
              : 'tool',
        args,
        resultMessageId: undefined
      }
    ]
  })
}

function projectMessage(event: TrajectoryMessageEvent): TrajectoryMessageView {
  const raw = event.message
  const blocks = contentParts(raw.content)
  const kwargs = record(raw.additional_kwargs)
  const additionalReasoning =
    typeof kwargs?.reasoning_content === 'string'
      ? kwargs.reasoning_content
      : ''
  const messageRole = role(raw.role)
  const responseMetadata = record(raw.response_metadata)
  const id =
    typeof raw.id === 'string' && raw.id ? raw.id : `message-${event.seq}`
  const view: TrajectoryMessageView = {
    id,
    seq: event.seq,
    role: messageRole,
    agent: event.agent ?? undefined,
    source: event.source ?? undefined,
    parentIds: event.parent_ids,
    name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
    modelProvider:
      typeof responseMetadata?.model_provider === 'string' &&
      responseMetadata.model_provider
        ? responseMetadata.model_provider
        : undefined,
    modelName:
      typeof responseMetadata?.model_name === 'string' &&
      responseMetadata.model_name
        ? responseMetadata.model_name
        : undefined,
    content: blocks.content,
    reasoning: [additionalReasoning, blocks.reasoning]
      .filter(Boolean)
      .join('\n\n'),
    toolCalls: toolCalls(raw, event.seq),
    toolCallId:
      typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    artifact: raw.artifact,
    diff:
      typeof kwargs?.diff === 'string' && kwargs.diff ? kwargs.diff : undefined,
    diffTruncated: kwargs?.diff_truncated === true ? true : undefined,
    usage: usage(raw),
    searchable: ''
  }
  view.searchable = [
    view.role,
    view.agent ?? '',
    view.source ?? '',
    // The header hides a name on assistant turns, so search must not surface
    // them either; tool messages keep their tool name.
    view.role === 'assistant' ? '' : view.name,
    view.modelProvider ?? '',
    view.modelName ?? '',
    view.content,
    view.reasoning,
    ...view.toolCalls.flatMap((call) => [call.name, JSON.stringify(call.args)]),
    view.artifact === undefined ? '' : JSON.stringify(view.artifact)
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return view
}

function linkToolResults(messages: TrajectoryMessageView[]): void {
  const results = messages.filter((message) => message.toolCallId)
  const proposed = new Map<ToolCallView, TrajectoryMessageView>()
  const resultRequests = new Map<string, number>()
  for (const message of messages) {
    for (const call of message.toolCalls) {
      // Tool IDs may repeat in parallel subagents; select the closest execution branch.
      const candidates = results.filter((result) => {
        if (result.toolCallId !== call.id || result.seq <= message.seq)
          return false
        if (message.agent && result.agent && message.agent !== result.agent)
          return false
        // The last parent is the model/tools node, which differs within one
        // conversation. Earlier parents identify the owning execution branch.
        const left = message.parentIds?.slice(0, -1)
        const right = result.parentIds?.slice(0, -1)
        if (left?.length && right?.length)
          return (
            left.length === right.length &&
            left.every((parent, index) => parent === right[index])
          )
        return true
      })
      const scored = candidates
        .map((result) => {
          const left = message.parentIds ?? []
          const right = result.parentIds ?? []
          let common = 0
          while (common < left.length && left[common] === right[common])
            common += 1
          return { result, common }
        })
        .sort((a, b) => b.common - a.common)
      const result =
        scored.length === 1 ||
        (scored.length > 1 && scored[0]!.common > scored[1]!.common)
          ? scored[0]?.result
          : undefined
      if (result) {
        proposed.set(call, result)
        resultRequests.set(result.id, (resultRequests.get(result.id) ?? 0) + 1)
      }
    }
  }
  for (const message of messages) {
    for (const call of message.toolCalls) {
      const candidate = proposed.get(call)
      // A unique result candidate can still be ambiguous on the request side.
      const result =
        candidate && resultRequests.get(candidate.id) === 1
          ? candidate
          : undefined
      call.resultMessageId = result?.id
      if (result) result.requestAnchorId = call.anchorId
      // The tool reports the diff on its result message; the call renders it.
      if (result?.diff) {
        call.diff = result.diff
        if (result.diffTruncated) call.diffTruncated = true
        // The diff is displayed with this message, so it belongs in the index.
        message.searchable += '\n' + result.diff.toLowerCase()
      }
    }
  }
}

function totalRecordedUsage(
  events: TrajectoryEvent[],
  messages: TrajectoryMessageView[]
): UsageView {
  const totalUsage: UsageView = {
    input: undefined,
    output: undefined,
    cacheRead: undefined,
    cacheCreation: undefined,
    reasoning: undefined,
    total: undefined
  }
  const hasCallRecords = events.some(
    (event) => event.event === 'model_calls_start'
  )
  const responses = new Map<string, string[]>()
  const selected = new Map<string, string>()
  for (const event of events) {
    if (event.event === 'model_call_start') responses.set(event.call_id!, [])
    else if (event.event === 'message' && event.call_id)
      responses.get(event.call_id)?.push(event.message.id as string)
    else if (event.event === 'model_call_end')
      selected.set(event.call_id!, event.message_id!)
  }
  // Keep known usage for interrupted calls only when their response is unambiguous.
  for (const [callId, ids] of responses) {
    if (!selected.has(callId) && ids.length === 1) selected.set(callId, ids[0]!)
  }
  // Viewer totals project recorded usage; accounting reports own coverage assessment.
  const covered = hasCallRecords
    ? [...responses.keys()].map((callId) =>
        messages.find((message) => message.id === selected.get(callId))
      )
    : messages.filter((message) => message.role === 'assistant')
  for (const key of [
    'input',
    'output',
    'cacheRead',
    'cacheCreation',
    'reasoning',
    'total'
  ] as const) {
    const values = covered.map((message) => message?.usage?.[key])
    if (
      values.length &&
      values.every((value): value is number => value !== undefined)
    )
      totalUsage[key] = values.reduce((sum, value) => sum + value, 0)
  }
  return totalUsage
}

export function buildTrajectoryDocument(
  events: TrajectoryEvent[]
): TrajectoryDocument {
  const messages = events
    .filter(
      (event): event is TrajectoryMessageEvent => event.event === 'message'
    )
    .map(projectMessage)
  linkToolResults(messages)
  return { messages, totalUsage: totalRecordedUsage(events, messages) }
}
