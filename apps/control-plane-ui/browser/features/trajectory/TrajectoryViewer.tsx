import React from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Code,
  Collapse,
  Group,
  Modal,
  Paper,
  Popover,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import {
  IconArrowDown,
  IconArrowUp,
  IconBraces,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconCpu,
  IconDownload,
  IconExternalLink,
  IconMessage,
  IconRobot,
  IconRoute,
  IconSearch,
  IconSettings,
  IconTool,
  IconUser
} from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  api,
  isAbortError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { ResourceLoadError } from '../../shared/ResourceLoadError.js'
import { useMessages } from '../../shared/i18n.js'
import { LatestRequestGuard } from '../../shared/latest-request.js'
import { BREAKPOINTS, ICON_SIZE } from '../../shared/design.js'
import { LoadingState } from '../../shared/StateMessage.js'
import {
  normalizeTrajectory,
  type ToolCallView,
  type TrajectoryEvent,
  type TrajectoryMessageView,
  type TrajectoryRole,
  type UsageView
} from './trajectory-model.js'
import {
  MAX_MINIMAP_MARKS,
  MINIMAP_HEIGHT,
  minimapBuckets,
  minimapMarkWidth,
  minimapTicks,
  nearestSegment,
  sameSegments,
  type MinimapSegment
} from './trajectory-minimap.js'

export type { TrajectoryEvent } from './trajectory-model.js'

export interface TrajectoryTarget {
  title: string
  contentHref: string
  downloadHref: string
  pageHref: string
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2
  }).format(value)
}

function TokenUsageDetails({ usage }: { usage: UsageView }): React.JSX.Element {
  const t = useMessages()
  const metric = (
    label: string,
    value: number | undefined,
    subsets: ReadonlyArray<readonly [string, number | undefined]> = []
  ): React.JSX.Element | null => {
    if (value === undefined && subsets.every(([, item]) => item === undefined))
      return null
    return (
      <div className="trajectory-usage-group">
        <div className="trajectory-usage-metric">
          <Text size="xs">{label}</Text>
          <Text size="sm" fw={600}>
            {value === undefined ? '—' : value.toLocaleString()}
          </Text>
        </div>
        {subsets.map(
          ([subsetLabel, subsetValue]) =>
            subsetValue !== undefined && (
              <div className="trajectory-usage-subset" key={subsetLabel}>
                <Text size="xs" c="dimmed">
                  {subsetLabel}
                </Text>
                <Text size="xs" c="dimmed">
                  {subsetValue.toLocaleString()}
                </Text>
              </div>
            )
        )}
      </div>
    )
  }
  return (
    <div className="trajectory-usage-details">
      {metric(t('trajectoryTokensIn'), usage.input, [
        [t('trajectoryCacheRead'), usage.cacheRead],
        [t('trajectoryCacheCreation'), usage.cacheCreation]
      ])}
      {metric(t('trajectoryTokensOut'), usage.output, [
        [t('trajectoryReasoningTokens'), usage.reasoning]
      ])}
      {usage.total !== undefined && (
        <div className="trajectory-usage-total">
          <Text size="xs">{t('trajectoryTokensTotal')}</Text>
          <Text size="sm" fw={600}>
            {usage.total.toLocaleString()}
          </Text>
        </div>
      )}
    </div>
  )
}

function TokenUsagePopover({
  usage,
  compact = false
}: {
  usage: UsageView
  compact?: boolean
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Popover
      width={248}
      position="bottom-end"
      shadow="xs"
      withArrow
      arrowSize={8}
    >
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          leftSection={<IconCpu size={ICON_SIZE.xs} />}
          aria-label={t('trajectoryUsageDetails')}
        >
          {compact
            ? usage.total === undefined
              ? t('trajectoryUsageDetails')
              : formatTokens(usage.total)
            : usage.total === undefined
              ? t('trajectoryUsageDetails')
              : `${formatTokens(usage.total)} ${t('trajectoryTokenUnit')}`}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <TokenUsageDetails usage={usage} />
      </Popover.Dropdown>
    </Popover>
  )
}

function HighlightText({
  value,
  query
}: {
  value: string
  query: string
}): React.JSX.Element {
  const needle = query.trim()
  if (!needle) return <>{value}</>
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = value.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={index}>{part}</mark>
        ) : (
          part
        )
      )}
    </>
  )
}

function highlightNode(node: React.ReactNode, query: string): React.ReactNode {
  if (typeof node === 'string')
    return <HighlightText value={node} query={query} />
  if (Array.isArray(node))
    return node.map((item, index) => (
      <React.Fragment key={index}>{highlightNode(item, query)}</React.Fragment>
    ))
  if (React.isValidElement<{ children?: React.ReactNode }>(node))
    return React.cloneElement(
      node,
      undefined,
      highlightNode(node.props.children, query)
    )
  return node
}

function HighlightedMarkdown({
  children,
  query
}: {
  children: string
  query: string
}): React.JSX.Element {
  const highlight = ({
    children: node
  }: {
    children?: React.ReactNode
  }): React.ReactNode => highlightNode(node, query)
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children: node }) => <p>{highlight({ children: node })}</p>,
        li: ({ children: node }) => <li>{highlight({ children: node })}</li>,
        code: ({ children: node }) => (
          <code>{highlight({ children: node })}</code>
        ),
        td: ({ children: node }) => <td>{highlight({ children: node })}</td>,
        th: ({ children: node }) => <th>{highlight({ children: node })}</th>
      }}
    >
      {children}
    </ReactMarkdown>
  )
}

function CopyButton({ value }: { value: string }): React.JSX.Element {
  const t = useMessages()
  const [copied, setCopied] = React.useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Tooltip label={copied ? t('copied') : t('copy')}>
      <ActionIcon variant="subtle" color="gray" onClick={() => void copy()}>
        {copied ? (
          <IconCheck size={ICON_SIZE.sm} />
        ) : (
          <IconCopy size={ICON_SIZE.sm} />
        )}
      </ActionIcon>
    </Tooltip>
  )
}

function rolePresentation(role: TrajectoryRole): {
  color: string
  icon: React.JSX.Element
  key:
    | 'trajectorySystem'
    | 'trajectoryHuman'
    | 'trajectoryAssistant'
    | 'trajectoryTool'
    | 'trajectoryUnknown'
} {
  if (role === 'system')
    return {
      color: 'gray',
      icon: <IconSettings size={ICON_SIZE.md} />,
      key: 'trajectorySystem'
    }
  if (role === 'human')
    return {
      color: 'orange',
      icon: <IconUser size={ICON_SIZE.md} />,
      key: 'trajectoryHuman'
    }
  if (role === 'assistant')
    return {
      color: 'blue',
      icon: <IconRobot size={ICON_SIZE.md} />,
      key: 'trajectoryAssistant'
    }
  if (role === 'tool')
    return {
      color: 'green',
      icon: <IconTool size={ICON_SIZE.md} />,
      key: 'trajectoryTool'
    }
  return {
    color: 'gray',
    icon: <IconSettings size={ICON_SIZE.md} />,
    key: 'trajectoryUnknown'
  }
}

function Section({
  kind,
  title,
  value,
  openedInitially = false,
  force,
  children,
  icon,
  color = 'blue'
}: {
  kind: 'message' | 'reasoning' | 'result' | 'artifact'
  title: string
  value: string
  openedInitially?: boolean
  force: number
  children: React.ReactNode
  icon?: React.ReactNode
  color?: string
}): React.JSX.Element {
  const [opened, setOpened] = React.useState(openedInitially)
  const previousForce = React.useRef(force)
  React.useEffect(() => {
    if (force === previousForce.current) return
    previousForce.current = force
    setOpened(force > 0)
  }, [force])
  return (
    <div className="trajectory-section" data-trajectory-section={kind}>
      <Group
        justify="space-between"
        wrap="nowrap"
        className="trajectory-section-header"
      >
        <Button
          variant="subtle"
          color={color}
          size="compact-sm"
          className="trajectory-section-toggle"
          aria-expanded={opened}
          leftSection={
            opened ? (
              <IconChevronDown size={ICON_SIZE.sm} />
            ) : (
              <IconChevronRight size={ICON_SIZE.sm} />
            )
          }
          onClick={() => setOpened((current) => !current)}
        >
          <Group gap={6} wrap="nowrap">
            {icon}
            {title}
          </Group>
        </Button>
        <CopyButton value={value} />
      </Group>
      <Collapse expanded={opened}>
        <div className="trajectory-section-content">{children}</div>
      </Collapse>
    </div>
  )
}

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

function ToolArguments({
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

function ToolCall({
  call,
  query
}: {
  call: ToolCallView
  query: string
}): React.JSX.Element {
  const t = useMessages()
  const jump = (): void => {
    if (!call.resultMessageId) return
    scrollToTrajectoryElement(`trajectory-${call.resultMessageId}`)
  }
  return (
    <div className="trajectory-tool-call">
      <Group
        justify="space-between"
        wrap="nowrap"
        className="trajectory-tool-call-header"
      >
        <Group gap="xs" wrap="nowrap">
          <IconTool size={ICON_SIZE.md} color="var(--mantine-color-green-6)" />
          <Text fw={600} size="sm" c="green.7" truncate>
            <HighlightText value={call.name} query={query} />
          </Text>
        </Group>
        {call.resultMessageId && (
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<IconArrowDown size={ICON_SIZE.sm} />}
            onClick={jump}
          >
            {t('trajectoryJumpResult')}
          </Button>
        )}
      </Group>
      <div className="trajectory-tool-call-body">
        <ToolArguments args={call.args} query={query} />
      </div>
    </div>
  )
}

function ToolCalls({
  calls,
  force,
  query
}: {
  calls: ToolCallView[]
  force: number
  query: string
}): React.JSX.Element {
  const t = useMessages()
  const [opened, setOpened] = React.useState(true)
  const previousForce = React.useRef(force)
  React.useEffect(() => {
    if (force === previousForce.current) return
    previousForce.current = force
    setOpened(force > 0)
  }, [force])
  return (
    <div className="trajectory-tool-calls">
      <Button
        variant="subtle"
        color="green"
        size="compact-sm"
        className="trajectory-tool-calls-toggle"
        aria-expanded={opened}
        leftSection={
          opened ? (
            <IconChevronDown size={ICON_SIZE.sm} />
          ) : (
            <IconChevronRight size={ICON_SIZE.sm} />
          )
        }
        onClick={() => setOpened((current) => !current)}
      >
        <Group gap={6} wrap="nowrap">
          <IconTool size={ICON_SIZE.sm} />
          <Text fw={600} size="sm">
            {t('trajectoryToolCalls')} · {calls.length}
          </Text>
        </Group>
      </Button>
      <Collapse expanded={opened}>
        <div className="trajectory-tool-calls-body">
          {calls.map((call) => (
            <div id={`trajectory-call-${call.id}`} key={call.id}>
              <ToolCall call={call} query={query} />
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  )
}

function TrajectoryMessage({
  message,
  force,
  query
}: {
  message: TrajectoryMessageView
  force: number
  query: string
}): React.JSX.Element {
  const t = useMessages()
  const presentation = rolePresentation(message.role)
  const jumpToCall = (): void => {
    if (!message.toolCallId) return
    scrollToTrajectoryElement(`trajectory-call-${message.toolCallId}`)
  }
  return (
    <Paper
      id={`trajectory-${message.id}`}
      data-trajectory-message-key={messageKey(message)}
      data-trajectory-role={message.role}
      withBorder
      className={`trajectory-message trajectory-${message.role}`}
    >
      <Group justify="space-between" wrap="wrap" p="sm" gap="xs">
        <Group gap="xs" wrap="wrap">
          <Badge
            variant="light"
            color={presentation.color}
            leftSection={presentation.icon}
          >
            {t(presentation.key)}
          </Badge>
          <Text size="sm" c="dimmed">
            #{message.seq}
            {message.name && (
              <>
                {' · '}
                <HighlightText value={message.name} query={query} />
              </>
            )}
          </Text>
          {message.status && (
            <Badge size="xs" variant="outline">
              {message.status}
            </Badge>
          )}
        </Group>
        {(message.toolCallId || message.usage) && (
          <Group gap="xs" wrap="wrap">
            {message.toolCallId && (
              <Button
                variant="subtle"
                size="compact-xs"
                data-trajectory-action="back-to-call"
                leftSection={<IconArrowUp size={ICON_SIZE.sm} />}
                onClick={jumpToCall}
              >
                {t('trajectoryJumpCall')}
              </Button>
            )}
            {message.usage && (
              <div className="trajectory-token-metrics">
                <TokenUsagePopover usage={message.usage} compact />
              </div>
            )}
          </Group>
        )}
      </Group>
      <div className="trajectory-message-body">
        {message.reasoning && (
          <Section
            kind="reasoning"
            title={t('trajectoryReasoning')}
            value={message.reasoning}
            force={force}
            icon={<IconBrain size={ICON_SIZE.sm} />}
            color="violet"
          >
            <div className="memory-markdown memory-markdown-full">
              <HighlightedMarkdown query={query}>
                {message.reasoning}
              </HighlightedMarkdown>
            </div>
          </Section>
        )}
        {message.content && (
          <Section
            kind={message.role === 'tool' ? 'result' : 'message'}
            title={
              message.role === 'tool'
                ? t('trajectoryResult')
                : t('trajectoryContent')
            }
            value={message.content}
            openedInitially={
              message.content.length <= 600 && message.role !== 'system'
            }
            force={force}
            icon={<IconMessage size={ICON_SIZE.sm} />}
            color={message.role === 'tool' ? 'green' : 'blue'}
          >
            {message.role === 'tool' ? (
              <Code block className="trajectory-tool-output">
                <HighlightText value={message.content} query={query} />
              </Code>
            ) : (
              <div className="memory-markdown memory-markdown-full">
                <HighlightedMarkdown query={query}>
                  {message.content}
                </HighlightedMarkdown>
              </div>
            )}
          </Section>
        )}
        {message.toolCalls.length > 0 && (
          <ToolCalls calls={message.toolCalls} force={force} query={query} />
        )}
        {message.artifact !== undefined && message.artifact !== null && (
          <Section
            kind="artifact"
            title={t('trajectoryArtifact')}
            value={JSON.stringify(message.artifact, null, 2)}
            force={force}
            icon={<IconBraces size={ICON_SIZE.sm} />}
            color="gray"
          >
            <Code block>
              <HighlightText
                value={JSON.stringify(message.artifact, null, 2)}
                query={query}
              />
            </Code>
          </Section>
        )}
      </div>
    </Paper>
  )
}

const ROLES: TrajectoryRole[] = [
  'system',
  'human',
  'assistant',
  'tool',
  'unknown'
]

function scrollParent(element: HTMLElement): HTMLElement | undefined {
  let ancestor = element.parentElement
  while (ancestor) {
    const style = getComputedStyle(ancestor)
    if (/(auto|scroll)/.test(style.overflowY)) return ancestor
    ancestor = ancestor.parentElement
  }
  return undefined
}

function scrollToTrajectoryElement(
  id: string,
  behavior?: ScrollBehavior
): void {
  document.getElementById(id)?.scrollIntoView({
    behavior:
      behavior ??
      (window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth'),
    block: 'center'
  })
}

function messageKey(message: TrajectoryMessageView): string {
  return `${message.seq}:${message.id}:${message.role}`
}

function messagePreview(message: TrajectoryMessageView): string {
  const value =
    message.content || message.reasoning || message.name || message.role
  const preview = value.replaceAll(/\s+/g, ' ').trim().slice(0, 120)
  return preview || message.role
}

const MinimapMark = React.memo(function MinimapMark({
  top,
  width,
  current,
  preview
}: {
  top: number
  width: number
  current: boolean
  preview: boolean
}): React.JSX.Element {
  return (
    <span
      className="trajectory-minimap-segment"
      data-current={current ? 'true' : undefined}
      data-preview={preview ? 'true' : undefined}
      style={{ top: `${top}px`, width: `${width}px` }}
    />
  )
})

function TrajectoryMinimap({
  messages,
  timelineRef,
  timelineId
}: {
  messages: TrajectoryMessageView[]
  timelineRef: React.RefObject<HTMLDivElement | null>
  timelineId: string
}): React.JSX.Element {
  const t = useMessages()
  const [segments, setSegments] = React.useState<MinimapSegment[]>([])
  const [current, setCurrent] = React.useState(0)
  const [hovered, setHovered] = React.useState<number | null>(null)
  const [topOffset, setTopOffset] = React.useState<number | null>(null)

  // A layout effect measures the scrollport before the first paint, so the
  // modal rail never shows its 50vh fallback for a frame.
  React.useLayoutEffect(() => {
    const timeline = timelineRef.current
    if (!timeline) return
    const scroller = scrollParent(timeline)
    const scrollTarget = scroller ?? window
    let layoutFrame = 0
    let scrollFrame = 0
    let measured: MinimapSegment[] = []

    const updateCurrent = (): void => {
      if (measured.length === 0) return
      const timelineRect = timeline.getBoundingClientRect()
      if (timelineRect.height <= 0) return
      const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0
      const viewportHeight = scroller
        ? scroller.clientHeight
        : window.innerHeight
      const center =
        (viewportTop - timelineRect.top + viewportHeight / 2) /
        timelineRect.height
      const next = nearestSegment(measured, center)
      setCurrent((value) => (value === next ? value : next))
    }

    const updateTop = (): void => {
      const height = scroller ? scroller.clientHeight : window.innerHeight
      const next = Math.max(8, (height - MINIMAP_HEIGHT) / 2)
      setTopOffset((value) => (value === next ? value : next))
    }

    const measure = (): void => {
      layoutFrame = 0
      updateTop()
      const timelineRect = timeline.getBoundingClientRect()
      if (timelineRect.height <= 0) return
      const byKey = new Map(
        messages.map((message) => [messageKey(message), message])
      )
      const next: MinimapSegment[] = []
      for (const node of timeline.querySelectorAll<HTMLElement>(
        ':scope > [data-trajectory-message-key]'
      )) {
        const message = byKey.get(node.dataset.trajectoryMessageKey ?? '')
        if (!message) continue
        const rect = node.getBoundingClientRect()
        next.push({
          message,
          top: (rect.top - timelineRect.top) / timelineRect.height,
          height: rect.height / timelineRect.height
        })
      }
      measured = next
      setSegments((value) => (sameSegments(value, next) ? value : next))
      updateCurrent()
    }

    const scheduleMeasure = (): void => {
      cancelAnimationFrame(layoutFrame)
      layoutFrame = requestAnimationFrame(measure)
    }
    const scheduleCurrent = (): void => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(updateCurrent)
    }

    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(timeline)
    scrollTarget.addEventListener('scroll', scheduleCurrent, { passive: true })
    window.addEventListener('resize', scheduleMeasure)
    measure()
    return (): void => {
      cancelAnimationFrame(layoutFrame)
      cancelAnimationFrame(scrollFrame)
      resizeObserver.disconnect()
      scrollTarget.removeEventListener('scroll', scheduleCurrent)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [messages, timelineRef])

  const ticks = minimapTicks(segments.length)
  if (segments.length === 0)
    return (
      <nav
        className="trajectory-minimap"
        aria-label={t('trajectoryMinimap')}
        style={{
          height: MINIMAP_HEIGHT,
          top: topOffset ?? `calc(50vh - ${MINIMAP_HEIGHT / 2}px)`
        }}
      />
    )

  const active = Math.min(current, segments.length - 1)
  const dense = segments.length > MAX_MINIMAP_MARKS
  const buckets = dense ? minimapBuckets(segments.length, ticks) : []
  const currentBucket = dense
    ? buckets.find((bucket) => bucket.start <= active && active <= bucket.end)
    : undefined
  const hoveredIndex =
    hovered === null ? null : Math.min(hovered, segments.length - 1)
  const hoveredMessage =
    hoveredIndex === null ? undefined : segments[hoveredIndex]?.message
  const currentMessage = segments[active]?.message
  const currentLabel = currentMessage
    ? `${t(rolePresentation(currentMessage.role).key)} #${currentMessage.seq}: ${messagePreview(currentMessage)}`
    : undefined

  const indexAt = (clientY: number, rect: DOMRect): number => {
    if (ticks.gap === 0) return 0
    return Math.max(
      0,
      Math.min(
        segments.length - 1,
        Math.round((clientY - rect.top - ticks.start) / ticks.gap)
      )
    )
  }

  const navigate = (index: number): void => {
    const message = segments[index]?.message
    if (!message) return
    // The rail is a direct ordering control: jump instantly and let the scroll
    // listener derive the current message. A smooth scroll would keep firing
    // scroll events while a second key press still uses the old index.
    scrollToTrajectoryElement(`trajectory-${message.id}`, 'auto')
  }

  return (
    <nav
      className="trajectory-minimap"
      aria-label={t('trajectoryMinimap')}
      style={{
        height: MINIMAP_HEIGHT,
        top: topOffset ?? `calc(50vh - ${MINIMAP_HEIGHT / 2}px)`
      }}
    >
      <div
        className="trajectory-minimap-track"
        role="slider"
        tabIndex={0}
        aria-label={t('trajectoryMinimapPosition')}
        aria-controls={timelineId}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={segments.length}
        aria-valuenow={active + 1}
        aria-valuetext={currentLabel}
        onClick={(event) => {
          navigate(
            indexAt(event.clientY, event.currentTarget.getBoundingClientRect())
          )
        }}
        onMouseMove={(event) => {
          setHovered(
            indexAt(event.clientY, event.currentTarget.getBoundingClientRect())
          )
        }}
        onMouseLeave={() => setHovered(null)}
        onFocus={() => setHovered(active)}
        onBlur={() => setHovered(null)}
        onKeyDown={(event) => {
          const last = segments.length - 1
          let next: number | undefined
          if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
            next = Math.max(0, active - 1)
          else if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
            next = Math.min(last, active + 1)
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = last
          else if (event.key === 'Enter' || event.key === ' ') next = active
          if (next === undefined) return
          event.preventDefault()
          setHovered(next)
          navigate(next)
        }}
      >
        <div className="trajectory-minimap-marks" aria-hidden="true">
          {dense ? (
            <>
              {buckets.map((bucket) => {
                const preview =
                  hoveredIndex !== null &&
                  bucket.start <= hoveredIndex &&
                  hoveredIndex <= bucket.end
                return (
                  <MinimapMark
                    key={`bucket-${bucket.start}`}
                    top={bucket.top}
                    width={minimapMarkWidth(false, preview)}
                    current={false}
                    preview={preview}
                  />
                )
              })}
              {currentMessage && (
                <MinimapMark
                  key="current"
                  top={currentBucket?.top ?? ticks.start + active * ticks.gap}
                  width={minimapMarkWidth(true, false)}
                  current
                  preview={false}
                />
              )}
            </>
          ) : (
            segments.map((segment, index) => {
              const preview = index === hoveredIndex
              return (
                <MinimapMark
                  key={messageKey(segment.message)}
                  top={ticks.start + index * ticks.gap}
                  width={minimapMarkWidth(index === active, preview)}
                  current={index === active}
                  preview={preview}
                />
              )
            })
          )}
        </div>
      </div>
      {hoveredMessage && hoveredIndex !== null && (
        <Paper
          withBorder
          p="xs"
          className="trajectory-minimap-preview"
          aria-hidden="true"
          style={{ top: `${ticks.start + hoveredIndex * ticks.gap}px` }}
        >
          <Text size="xs" fw={700}>
            {t(rolePresentation(hoveredMessage.role).key)} · #
            {hoveredMessage.seq}
          </Text>
          <Text size="xs" lineClamp={3} c="dimmed">
            {messagePreview(hoveredMessage)}
          </Text>
        </Paper>
      )}
    </nav>
  )
}

export function TrajectoryTimeline({
  events
}: {
  events: TrajectoryEvent[]
}): React.JSX.Element {
  const t = useMessages()
  const timelineId = React.useId()
  const narrowTrajectory = useMediaQuery(
    `(max-width: ${BREAKPOINTS.rail}px)`,
    false,
    {
      getInitialValueInEffect: false
    }
  )
  const document = React.useMemo(() => normalizeTrajectory(events), [events])
  const [query, setQuery] = React.useState('')
  const [roles, setRoles] = React.useState<TrajectoryRole[]>(ROLES)
  const [force, setForce] = React.useState(0)
  const timelineRef = React.useRef<HTMLDivElement>(null)
  const filtered = React.useMemo(
    () =>
      document.messages.filter(
        (message) =>
          roles.includes(message.role) &&
          message.searchable.includes(query.trim().toLowerCase())
      ),
    [document.messages, query, roles]
  )
  const toggleRole = (role: TrajectoryRole): void =>
    setRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : [...current, role]
    )
  return (
    <Stack gap="md">
      <Paper withBorder p="sm" className="trajectory-toolbar">
        <Group justify="space-between" align="start" wrap="wrap">
          <Stack gap="xs">
            <Group gap="xs" wrap="wrap">
              {ROLES.map((role) => {
                const presentation = rolePresentation(role)
                return (
                  <Checkbox
                    key={role}
                    checked={roles.includes(role)}
                    label={t(presentation.key)}
                    onChange={() => toggleRole(role)}
                  />
                )
              })}
            </Group>
            <Group gap={4} wrap="wrap">
              <Text size="xs" c="dimmed">
                {t('trajectoryShowing')
                  .replace('{shown}', String(filtered.length))
                  .replace('{total}', String(document.messages.length))}
              </Text>
              {Object.values(document.totalUsage).some(
                (value) => value !== undefined
              ) && <TokenUsagePopover usage={document.totalUsage} />}
            </Group>
          </Stack>
          <Group gap="xs" wrap="wrap">
            <TextInput
              leftSection={<IconSearch size={ICON_SIZE.sm} />}
              placeholder={t('trajectorySearch')}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => setForce((value) => Math.abs(value) + 1)}
            >
              {t('expandAll')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setForce((value) => -(Math.abs(value) + 1))}
            >
              {t('collapseAll')}
            </Button>
          </Group>
        </Group>
      </Paper>
      <div className="trajectory-layout">
        <Stack
          id={timelineId}
          gap="sm"
          className="trajectory-timeline"
          ref={timelineRef}
        >
          {filtered.map((message) => (
            <TrajectoryMessage
              key={messageKey(message)}
              message={message}
              force={force}
              query={query.trim()}
            />
          ))}
        </Stack>
        {!narrowTrajectory && (
          <TrajectoryMinimap
            messages={filtered}
            timelineRef={timelineRef}
            timelineId={timelineId}
          />
        )}
      </div>
    </Stack>
  )
}

export function TrajectoryViewer({
  target,
  onClose
}: {
  target: TrajectoryTarget | undefined
  onClose: () => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Modal
      opened={target !== undefined}
      onClose={onClose}
      title={
        target ? (
          <div className="trajectory-viewer-heading">
            <Group gap="sm" wrap="nowrap" className="trajectory-viewer-name">
              <IconRoute size={ICON_SIZE.lg} aria-hidden="true" />
              <Text fw={600} truncate>
                {target.title}
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Tooltip label={t('openFullPage')}>
                <ActionIcon
                  component="a"
                  href={target.pageHref}
                  target="_blank"
                  rel="noreferrer"
                  variant="default"
                  size="lg"
                  aria-label={t('openFullPage')}
                >
                  <IconExternalLink size={ICON_SIZE.md} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t('downloadOriginal')}>
                <ActionIcon
                  component="a"
                  href={target.downloadHref}
                  download
                  variant="default"
                  size="lg"
                  aria-label={t('downloadOriginal')}
                >
                  <IconDownload size={ICON_SIZE.md} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </div>
        ) : undefined
      }
      size="calc(100vw - 64px)"
      classNames={{
        header: 'trajectory-viewer-header',
        title: 'trajectory-viewer-title',
        body: 'memory-viewer-modal'
      }}
    >
      {target && <TrajectoryContent target={target} />}
    </Modal>
  )
}

export function TrajectoryContent({
  target
}: {
  target: TrajectoryTarget
}): React.JSX.Element {
  const t = useMessages()
  const [events, setEvents] = React.useState<TrajectoryEvent[]>([])
  const [error, setError] = React.useState<unknown>()
  const [loading, setLoading] = React.useState(false)
  const requests = React.useRef(new LatestRequestGuard())
  React.useEffect(() => {
    const request = requests.current.begin()
    setEvents([])
    setLoading(true)
    setError(undefined)
    void api<{ events: TrajectoryEvent[] }>(target.contentHref, {
      signal: request.signal
    })
      .then((body) => {
        if (request.isCurrent()) setEvents(body.events)
      })
      .catch((failure: unknown) => {
        if (request.isCurrent() && !isAbortError(failure)) setError(failure)
      })
      .finally(() => {
        if (request.isCurrent()) setLoading(false)
      })
    return request.cancel
  }, [t, target.contentHref])
  throwIfUnauthorized(error)
  if (error !== undefined)
    return (
      <div className="content-load-state">
        <ResourceLoadError message={t('trajectoryLoadFailed')} />
      </div>
    )
  if (loading) return <LoadingState message={t('loading')} />
  return <TrajectoryTimeline events={events} />
}
