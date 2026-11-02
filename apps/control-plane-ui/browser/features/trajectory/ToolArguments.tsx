import React from 'react'
import { Badge, Code, Group, SimpleGrid, Stack, Text } from '@mantine/core'

import { DiffView } from './DiffView.js'
import { HighlightText, HighlightedMarkdown } from './TrajectoryText.js'

const JSON_MAX_DEPTH = 3

function isPrimitive(
  value: unknown
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Only these argument keys are prose. Everything else is data: rendering an
// arbitrary string as markdown rewrites its whitespace, which is wrong for
// commands, code and file contents. Unknown keys deliberately fall back to a
// code block, so a new tool can never be silently mangled by a guess.
const PROSE_ARGUMENT_KEYS = new Set([
  'overview',
  'summary',
  'description',
  'notes',
  'note',
  'self_check_notes',
  'residual_risks',
  'target_claim',
  'explanation',
  'rationale',
  'message',
  'feedback'
])

function recordPreview(value: unknown): string {
  if (!isRecord(value)) return ''
  for (const key of ['title', 'name', 'label', 'summary']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '')
      return candidate.slice(0, 110)
  }
  const first = Object.values(value).find(
    (candidate) => typeof candidate === 'string' && candidate.trim() !== ''
  )
  return typeof first === 'string' ? first.slice(0, 110) : ''
}

function JsonRaw({
  value,
  query
}: {
  value: unknown
  query: string
}): React.JSX.Element {
  return (
    <details className="json-raw">
      <summary>Raw JSON</summary>
      <Code block>
        <HighlightText value={JSON.stringify(value, null, 2)} query={query} />
      </Code>
    </details>
  )
}

function JsonPrimitive({
  value,
  query
}: {
  value: unknown
  query: string
}): React.JSX.Element {
  if (value === null || value === undefined)
    return <span className="json-null">null</span>
  if (typeof value === 'string') {
    if (value.includes('\n'))
      return (
        <pre className="json-code json-code-block">
          <HighlightText value={value} query={query} />
        </pre>
      )
    return (
      <code className="json-code">
        <HighlightText value={value} query={query} />
      </code>
    )
  }
  return <code className="json-code">{String(value)}</code>
}

function JsonTableValue({
  value,
  query
}: {
  value: unknown
  query: string
}): React.JSX.Element {
  if (value === null || value === undefined)
    return <span className="json-null">null</span>
  if (typeof value === 'string')
    return (
      <span className="json-table-text">
        <HighlightText value={value} query={query} />
      </span>
    )
  return <code className="json-code">{String(value)}</code>
}

function JsonObjectView({
  value,
  query,
  depth
}: {
  value: Record<string, unknown>
  query: string
  depth: number
}): React.JSX.Element {
  const entries = Object.entries(value)
  if (entries.length === 0) return <span className="json-empty">{'{}'}</span>
  return (
    <div className="json-object">
      {entries.map(([key, child]) => {
        const complex = Array.isArray(child) || isRecord(child)
        if (complex)
          return (
            <div className="json-field" key={key}>
              <div className="json-field-key">
                <HighlightText value={key} query={query} />
              </div>
              <div className="json-field-body">
                <JsonValueView value={child} query={query} depth={depth + 1} />
              </div>
            </div>
          )
        return (
          <div className="json-row" key={key}>
            <div className="json-key">
              <HighlightText value={key} query={query} />
            </div>
            <div className="json-value">
              <JsonValueView value={child} query={query} depth={depth + 1} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function JsonTable({
  rows,
  keys,
  query
}: {
  rows: Record<string, unknown>[]
  keys: string[]
  query: string
}): React.JSX.Element {
  const numericKeys = new Set(
    keys.filter((key) => {
      const values = rows
        .map((row) => row[key])
        .filter((value) => value !== null && value !== undefined)
      return (
        values.length > 0 && values.every((value) => typeof value === 'number')
      )
    })
  )
  return (
    <div className="json-table-wrap">
      <table className="json-table">
        <thead>
          <tr>
            {keys.map((key) => (
              <th
                className={
                  numericKeys.has(key) ? 'json-table-number' : undefined
                }
                key={key}
              >
                <HighlightText value={key} query={query} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {keys.map((key) => (
                <td
                  className={
                    numericKeys.has(key) ? 'json-table-number' : undefined
                  }
                  data-label={key}
                  key={key}
                >
                  <JsonTableValue value={row[key]} query={query} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function JsonArrayView({
  value,
  query,
  depth
}: {
  value: unknown[]
  query: string
  depth: number
}): React.JSX.Element {
  if (value.length === 0) return <span className="json-empty">[]</span>

  const allPrimitive = value.every(isPrimitive)
  const allShortPrimitive =
    allPrimitive &&
    value.every(
      (item) =>
        typeof item !== 'string' || (item.length <= 120 && !item.includes('\n'))
    )
  if (allShortPrimitive)
    return (
      <div className="json-chips">
        {value.map((item, index) => (
          <code className="json-code" key={index}>
            {item === null ? 'null' : String(item)}
          </code>
        ))}
      </div>
    )

  const allFlatObjects =
    value.length > 0 &&
    value.every(
      (item) => isRecord(item) && Object.values(item).every(isPrimitive)
    )
  const keys = allFlatObjects
    ? [
        ...new Set(
          value.flatMap((item) => (isRecord(item) ? Object.keys(item) : []))
        )
      ]
    : []
  if (allFlatObjects && keys.length > 0 && keys.length <= 6)
    return <JsonTable rows={value.filter(isRecord)} keys={keys} query={query} />

  if (value.every(isRecord))
    return (
      <div className="json-array">
        {value.map((item, index) => (
          <details className="json-record" key={index} open={index === 0}>
            <summary>
              <span className="json-index">#{index + 1}</span>
              <span className="json-record-preview">
                {recordPreview(item) || `Item ${index + 1}`}
              </span>
            </summary>
            <div className="json-record-body">
              <JsonValueView value={item} query={query} depth={depth + 1} />
            </div>
          </details>
        ))}
      </div>
    )

  return (
    <div className="json-array">
      {value.map((item, index) => (
        <div className="json-array-item" key={index}>
          <span className="json-index">#{index + 1}</span>
          <JsonValueView value={item} query={query} depth={depth + 1} />
        </div>
      ))}
    </div>
  )
}

function JsonValueView({
  value,
  query,
  depth = 0
}: {
  value: unknown
  query: string
  depth?: number
}): React.JSX.Element {
  if ((Array.isArray(value) || isRecord(value)) && depth > JSON_MAX_DEPTH)
    return <JsonRaw value={value} query={query} />
  if (Array.isArray(value))
    return <JsonArrayView value={value} query={query} depth={depth} />
  if (isRecord(value))
    return <JsonObjectView value={value} query={query} depth={depth} />
  return <JsonPrimitive value={value} query={query} />
}

const PATCH_KEYS = ['patchText', 'patch'] as const

function patchKeyFor(args: Record<string, unknown>): string | undefined {
  return PATCH_KEYS.find(
    (key) =>
      typeof args[key] === 'string' &&
      (args[key] as string).includes('*** Begin Patch')
  )
}

export function ToolArguments({
  args,
  query
}: {
  args: Record<string, unknown>
  query: string
}): React.JSX.Element {
  // Different agents spell the same before/after pair differently; the tool
  // name is not a reliable discriminator, so capability (keys) decides.
  const oldKey =
    'old_string' in args
      ? 'old_string'
      : 'oldString' in args
        ? 'oldString'
        : 'search_block' in args
          ? 'search_block'
          : undefined
  const newKey =
    'new_string' in args
      ? 'new_string'
      : 'newString' in args
        ? 'newString'
        : 'replace_block' in args
          ? 'replace_block'
          : undefined
  const patchKey = patchKeyFor(args)
  // Shell commands are data, not prose: markdown rendering collapses them into
  // an unreadable paragraph. Show them in a terminal-style block instead.
  const commandKey = ['command', 'cmd', 'script'].find(
    (key) => typeof args[key] === 'string'
  )
  const ordinary = Object.entries(args).filter(
    ([key]) =>
      key !== oldKey &&
      key !== newKey &&
      key !== 'todos' &&
      key !== patchKey &&
      key !== commandKey
  )
  return (
    <Stack gap="sm">
      {Array.isArray(args.todos) && (
        <Stack gap={4} className="trajectory-todos">
          {args.todos.map((item, index) => {
            const todo =
              typeof item === 'object' && item !== null
                ? (item as Record<string, unknown>)
                : {}
            const color =
              todo.status === 'completed'
                ? 'green'
                : todo.status === 'in_progress'
                  ? 'blue'
                  : 'gray'
            return (
              <Group key={index} gap="xs" wrap="nowrap">
                <Badge size="xs" variant="light" color={color}>
                  <HighlightText
                    value={String(todo.status ?? 'pending')}
                    query={query}
                  />
                </Badge>
                <Text size="sm">
                  <HighlightText
                    value={String(todo.content ?? '')}
                    query={query}
                  />
                </Text>
              </Group>
            )
          })}
        </Stack>
      )}
      {patchKey && <DiffView text={String(args[patchKey])} query={query} />}
      {commandKey && (
        <div className="trajectory-arg">
          <Text size="xs" fw={600} className="trajectory-arg-key">
            <HighlightText value={commandKey} query={query} />
          </Text>
          <pre className="json-code json-code-block" data-trajectory-command="">
            <HighlightText value={String(args[commandKey])} query={query} />
          </pre>
        </div>
      )}
      {ordinary.length > 0 && (
        <div className="trajectory-args">
          {ordinary.map(([key, value]) => (
            <div className="trajectory-arg" key={key}>
              <Text size="xs" fw={600} className="trajectory-arg-key">
                <HighlightText value={key} query={query} />
              </Text>
              {PROSE_ARGUMENT_KEYS.has(key) && typeof value === 'string' ? (
                <div className="memory-markdown json-markdown">
                  <HighlightedMarkdown query={query}>
                    {value}
                  </HighlightedMarkdown>
                </div>
              ) : (
                <JsonValueView value={value} query={query} />
              )}
            </div>
          ))}
        </div>
      )}
      {oldKey && newKey && (
        <SimpleGrid
          cols={{ base: 1, md: 2 }}
          spacing="sm"
          className="trajectory-diff"
        >
          <div className="trajectory-diff-old">
            <Text size="xs" fw={700} mb={6} className="trajectory-arg-key">
              {oldKey}
            </Text>
            <Code block>
              <HighlightText value={String(args[oldKey] ?? '')} query={query} />
            </Code>
          </div>
          <div className="trajectory-diff-new">
            <Text size="xs" fw={700} mb={6} className="trajectory-arg-key">
              {newKey}
            </Text>
            <Code block>
              <HighlightText value={String(args[newKey] ?? '')} query={query} />
            </Code>
          </div>
        </SimpleGrid>
      )}
    </Stack>
  )
}
