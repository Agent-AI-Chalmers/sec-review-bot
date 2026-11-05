import React from 'react'
import { Badge, Code, Group, SimpleGrid, Stack, Text } from '@mantine/core'

import { JsonValueView } from './JsonValueView.js'
import { DiffView } from './DiffView.js'
import { HighlightText, HighlightedMarkdown } from './TrajectoryText.js'

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
