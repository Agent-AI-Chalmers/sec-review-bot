interface ExecutionContext {
  seq: number
  agent?: string | null
  source?: string | null
  call_id?: string
  run_id?: string
  parent_ids?: string[]
  metadata?: Record<string, unknown>
}

export interface TrajectoryMessageEvent extends ExecutionContext {
  event: 'message'
  message: Record<string, unknown>
}

export type TrajectoryEvent =
  | TrajectoryMessageEvent
  | (ExecutionContext & {
      event:
        | 'model_calls_start'
        | 'model_calls_end'
        | 'model_call_start'
        | 'model_call_end'
      message_id?: string
      status?: string
    })

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validate one transcript record. */
export function validateTrajectoryEvent(value: unknown): TrajectoryEvent {
  const invalid = (): never => {
    throw new Error('invalid_trajectory_artifact')
  }
  if (!object(value)) return invalid()
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1)
    return invalid()
  for (const key of ['agent', 'source', 'run_id', 'call_id']) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      !nonempty(value[key])
    )
      return invalid()
  }
  if (
    value.parent_ids !== undefined &&
    (!Array.isArray(value.parent_ids) || !value.parent_ids.every(nonempty))
  )
    return invalid()
  if (value.metadata !== undefined && !object(value.metadata)) return invalid()
  if (value.event === 'message') {
    const message = value.message
    if (
      !object(message) ||
      'type' in message ||
      !nonempty(message.id) ||
      typeof message.role !== 'string' ||
      !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
      !(typeof message.content === 'string' || Array.isArray(message.content))
    )
      return invalid()
    const usage = message.usage_metadata
    if (usage !== undefined && usage !== null) {
      if (!object(usage)) return invalid()
      const fields = [
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
        'reasoning_tokens'
      ] as const
      if (
        Object.keys(usage).length !== fields.length ||
        !fields.every((key) => key in usage)
      )
        return invalid()
      for (const key of fields) {
        if (
          usage[key] !== null &&
          (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)
        )
          return invalid()
      }
      const input = usage.input_tokens as number | null
      const output = usage.output_tokens as number | null
      if (
        usage.total_tokens !==
        (input === null || output === null ? null : input + output)
      )
        return invalid()
      if (
        input !== null &&
        ((usage.cache_read_input_tokens as number | null) ?? 0) +
          ((usage.cache_creation_input_tokens as number | null) ?? 0) >
          input
      )
        return invalid()
      if (
        output !== null &&
        usage.reasoning_tokens !== null &&
        (usage.reasoning_tokens as number) > output
      )
        return invalid()
    }
  } else if (value.event === 'model_calls_start') {
    // No additional fields to validate.
  } else if (value.event === 'model_calls_end') {
    if (
      typeof value.status !== 'string' ||
      !['completed', 'failed', 'interrupted'].includes(value.status)
    )
      return invalid()
  } else if (
    value.event === 'model_call_start' ||
    value.event === 'model_call_end'
  ) {
    if (
      !nonempty(value.call_id) ||
      (value.event === 'model_call_end' && !nonempty(value.message_id))
    )
      return invalid()
  } else return invalid()
  return value as unknown as TrajectoryEvent
}

export function readTrajectoryJsonl(content: string): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = []
  const messages = new Map<string, TrajectoryMessageEvent>()
  const starts = new Set<string>()
  const ends = new Set<string>()
  let opened = false
  let closed = false
  let previous = 0
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const event = validateTrajectoryEvent(JSON.parse(line))
    if (closed || event.seq <= previous)
      throw new Error('invalid_trajectory_artifact')
    previous = event.seq
    if (event.event === 'message') {
      const id = event.message.id as string
      if (messages.has(id)) throw new Error('invalid_trajectory_artifact')
      if (opened && event.call_id !== undefined && !starts.has(event.call_id))
        throw new Error('invalid_trajectory_artifact')
      messages.set(id, event)
    } else if (event.event === 'model_calls_start') {
      if (opened) throw new Error('invalid_trajectory_artifact')
      opened = true
    } else if (event.event === 'model_calls_end') {
      if (!opened) throw new Error('invalid_trajectory_artifact')
      closed = true
    } else {
      const callId = event.call_id!
      if (!opened) throw new Error('invalid_trajectory_artifact')
      if (event.event === 'model_call_start') {
        if (starts.has(callId)) throw new Error('invalid_trajectory_artifact')
        starts.add(callId)
      } else {
        const response = messages.get(event.message_id!)
        if (
          !starts.has(callId) ||
          ends.has(callId) ||
          !response ||
          response.call_id !== callId
        )
          throw new Error('invalid_trajectory_artifact')
        ends.add(callId)
      }
    }
    events.push(event)
  }
  return events
}
