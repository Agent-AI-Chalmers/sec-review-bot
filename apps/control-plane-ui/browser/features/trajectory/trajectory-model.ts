export type TrajectoryRole =
  'system' | 'human' | 'assistant' | 'tool' | 'unknown'

export interface TrajectoryEvent {
  seq: number
  event: 'message'
  message: Record<string, unknown>
}

export interface ToolCallView {
  id: string
  name: string
  args: Record<string, unknown>
  resultMessageId: string | undefined
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
  content: string
  reasoning: string
  toolCalls: ToolCallView[]
  toolCallId: string | undefined
  status: string | undefined
  artifact: unknown
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

function positiveNumber(value: unknown): number | undefined {
  const parsed = number(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function role(value: unknown): TrajectoryRole {
  const kind = typeof value === 'string' ? value.toLowerCase() : ''
  if (kind === 'system') return 'system'
  if (kind === 'human' || kind === 'user') return 'human'
  if (kind === 'ai' || kind === 'assistant') return 'assistant'
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
  const direct = record(message.usage_metadata)
  const responseMetadata = record(message.response_metadata)
  const fallback =
    record(responseMetadata?.usage) ?? record(responseMetadata?.token_usage)
  const source = direct ?? fallback
  if (!source) return undefined
  const inputDetails =
    record(source.input_token_details) ?? record(source.prompt_tokens_details)
  const outputDetails =
    record(source.output_token_details) ??
    record(source.completion_tokens_details)
  const cacheRead =
    positiveNumber(inputDetails?.cache_read) ??
    positiveNumber(inputDetails?.cached_tokens) ??
    positiveNumber(source.cache_read_input_tokens)
  const cacheCreation =
    positiveNumber(inputDetails?.cache_creation) ??
    positiveNumber(source.cache_creation_input_tokens)
  const promptTokens = number(source.prompt_tokens)
  const ordinaryInput = number(source.input_tokens)
  // LangChain usage metadata and OpenAI prompt totals are already inclusive.
  // Raw Anthropic response metadata reports ordinary and cache input separately.
  const input =
    promptTokens ??
    (direct === undefined && inputDetails === undefined
      ? ordinaryInput === undefined
        ? undefined
        : ordinaryInput + (cacheRead ?? 0) + (cacheCreation ?? 0)
      : ordinaryInput)
  const result: UsageView = {
    input,
    output: number(source.output_tokens) ?? number(source.completion_tokens),
    cacheRead,
    cacheCreation,
    total: number(source.total_tokens),
    reasoning:
      number(outputDetails?.reasoning) ??
      number(outputDetails?.reasoning_tokens)
  }
  if (
    result.total === undefined &&
    result.input !== undefined &&
    result.output !== undefined
  )
    result.total = result.input + result.output
  return Object.values(result).some((item) => item !== undefined)
    ? result
    : undefined
}

function toolCalls(message: Record<string, unknown>): ToolCallView[] {
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls.flatMap((value, index) => {
    const call = record(value)
    if (!call) return []
    const args = record(call.args) ?? record(call.input) ?? {}
    return [
      {
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

export function normalizeTrajectory(
  events: TrajectoryEvent[]
): TrajectoryDocument {
  const messages = events.map((event) => {
    const raw = event.message
    const blocks = contentParts(raw.content)
    const kwargs = record(raw.additional_kwargs)
    const additionalReasoning =
      typeof kwargs?.reasoning_content === 'string'
        ? kwargs.reasoning_content
        : ''
    const messageRole = role(raw.type)
    const id =
      typeof raw.id === 'string' && raw.id ? raw.id : `message-${event.seq}`
    const view: TrajectoryMessageView = {
      id,
      seq: event.seq,
      role: messageRole,
      name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
      content: blocks.content,
      reasoning: [additionalReasoning, blocks.reasoning]
        .filter(Boolean)
        .join('\n\n'),
      toolCalls: toolCalls(raw),
      toolCallId:
        typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined,
      status: typeof raw.status === 'string' ? raw.status : undefined,
      artifact: raw.artifact,
      usage: usage(raw),
      searchable: ''
    }
    view.searchable = [
      view.role,
      view.name,
      view.content,
      view.reasoning,
      ...view.toolCalls.flatMap((call) => [
        call.name,
        JSON.stringify(call.args)
      ]),
      view.artifact === undefined ? '' : JSON.stringify(view.artifact)
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return view
  })

  // A direct LangGraph message-array export may omit `tool_call_id` from tool results
  // while retaining the canonical ordering: one assistant message with N calls followed
  // immediately by N results. Recover only that exact, unambiguous shape; partial or
  // interleaved result runs remain deliberately unlinked.
  for (let index = 0; index < messages.length; index += 1) {
    const calls = messages[index]?.toolCalls ?? []
    if (calls.length === 0) continue
    const results = messages.slice(index + 1, index + 1 + calls.length)
    if (
      results.length !== calls.length ||
      results.some(
        (message) => message.role !== 'tool' || message.toolCallId !== undefined
      )
    )
      continue
    const following = messages[index + 1 + calls.length]
    if (following?.role === 'tool' && following.toolCallId === undefined)
      continue
    results.forEach((message, resultIndex) => {
      message.toolCallId = calls[resultIndex]?.id
    })
  }

  const results = new Map(
    messages.flatMap((message) =>
      message.toolCallId ? [[message.toolCallId, message] as const] : []
    )
  )
  for (const message of messages) {
    for (const call of message.toolCalls) {
      call.resultMessageId = results.get(call.id)?.id
    }
  }
  const totalUsage: UsageView = {
    input: undefined,
    output: undefined,
    cacheRead: undefined,
    cacheCreation: undefined,
    reasoning: undefined,
    total: undefined
  }
  for (const message of messages) {
    for (const key of [
      'input',
      'output',
      'cacheRead',
      'cacheCreation',
      'reasoning',
      'total'
    ] as const) {
      const value = message.usage?.[key]
      if (value !== undefined) totalUsage[key] = (totalUsage[key] ?? 0) + value
    }
  }
  return { messages, totalUsage }
}
