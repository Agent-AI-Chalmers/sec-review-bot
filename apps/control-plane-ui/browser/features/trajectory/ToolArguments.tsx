import React from 'react'
import { Badge, Code, Group, SimpleGrid, Stack, Text } from '@mantine/core'

import { useMessages } from '../../shared/i18n.js'
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

function looksLikeMarkdown(value: string): boolean {
  return (
    value.includes('\n') ||
    /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(value) ||
    /\*\*[^*]+\*\*/.test(value) ||
    /\[[^\]]+\]\([^)]+\)/.test(value) ||
    (value.length > 80 && value.includes(' '))
  )
}

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
    if (looksLikeMarkdown(value))
      return (
        <div className="memory-markdown json-markdown">
          <HighlightedMarkdown query={query}>{value}</HighlightedMarkdown>
        </div>
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
        typeof item !== 'string' ||
        (item.length <= 120 && !item.includes('\n') && !looksLikeMarkdown(item))
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

export function ToolArguments({
  args,
  query
}: {
  args: Record<string, unknown>
  query: string
}): React.JSX.Element {
  const t = useMessages()
  const oldKey =
    'old_string' in args
      ? 'old_string'
      : 'search_block' in args
        ? 'search_block'
        : undefined
  const newKey =
    'new_string' in args
      ? 'new_string'
      : 'replace_block' in args
        ? 'replace_block'
        : undefined
  const ordinary = Object.entries(args).filter(
    ([key]) => key !== oldKey && key !== newKey && key !== 'todos'
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
      {ordinary.length > 0 && (
        <div className="trajectory-args">
          {ordinary.map(([key, value]) => (
            <div className="trajectory-arg" key={key}>
              <Text size="xs" fw={600} className="trajectory-arg-key">
                <HighlightText value={key} query={query} />
              </Text>
              <JsonValueView value={value} query={query} />
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
            <Text size="xs" fw={700} mb={6}>
              {t('trajectoryBefore')}
            </Text>
            <Code block>
              <HighlightText value={String(args[oldKey] ?? '')} query={query} />
            </Code>
          </div>
          <div className="trajectory-diff-new">
            <Text size="xs" fw={700} mb={6}>
              {t('trajectoryAfter')}
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
