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
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconCpu,
  IconDownload,
  IconExternalLink,
  IconRobot,
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
  normalizeTranscript,
  type ToolCallView,
  type TranscriptEvent,
  type TranscriptMessageView,
  type TranscriptRole
} from './transcript-model.js'
import {
  MAX_MINIMAP_MARKS,
  MINIMAP_HEIGHT,
  minimapBuckets,
  minimapMarkWidth,
  minimapTicks,
  nearestSegment,
  sameSegments,
  type MinimapSegment
} from './transcript-minimap.js'

export type { TranscriptEvent } from './transcript-model.js'

export interface TranscriptTarget {
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

function rolePresentation(role: TranscriptRole): {
  color: string
  icon: React.JSX.Element
  key:
    | 'transcriptSystem'
    | 'transcriptHuman'
    | 'transcriptAssistant'
    | 'transcriptTool'
    | 'transcriptUnknown'
} {
  if (role === 'system')
    return {
      color: 'gray',
      icon: <IconSettings size={ICON_SIZE.md} />,
      key: 'transcriptSystem'
    }
  if (role === 'human')
    return {
      color: 'orange',
      icon: <IconUser size={ICON_SIZE.md} />,
      key: 'transcriptHuman'
    }
  if (role === 'assistant')
    return {
      color: 'blue',
      icon: <IconRobot size={ICON_SIZE.md} />,
      key: 'transcriptAssistant'
    }
  if (role === 'tool')
    return {
      color: 'green',
      icon: <IconTool size={ICON_SIZE.md} />,
      key: 'transcriptTool'
    }
  return {
    color: 'gray',
    icon: <IconSettings size={ICON_SIZE.md} />,
    key: 'transcriptUnknown'
  }
}

function Section({
  title,
  value,
  openedInitially = false,
  force,
  children,
  icon
}: {
  title: string
  value: string
  openedInitially?: boolean
  force: number
  children: React.ReactNode
  icon?: React.ReactNode
}): React.JSX.Element {
  const [opened, setOpened] = React.useState(openedInitially)
  const previousForce = React.useRef(force)
  React.useEffect(() => {
    if (force === previousForce.current) return
    previousForce.current = force
    setOpened(force > 0)
  }, [force])
  return (
    <div className="transcript-section">
      <Group
        justify="space-between"
        wrap="nowrap"
        className="transcript-section-header"
      >
        <Button
          variant="subtle"
          color="gray"
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
        <div className="transcript-section-content">{children}</div>
      </Collapse>
    </div>
  )
}

function ValueView({
  value,
  query
}: {
  value: unknown
  query: string
}): React.JSX.Element {
  return typeof value === 'string' ? (
    <Text size="sm">
      <HighlightText value={value} query={query} />
    </Text>
  ) : (
    <Code block>
      <HighlightText value={JSON.stringify(value, null, 2)} query={query} />
    </Code>
  )
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
        <Stack gap={4} className="transcript-todos">
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
        <div className="transcript-args-table">
          {ordinary.map(([key, value]) => (
            <React.Fragment key={key}>
              <Text size="xs" fw={700} c="dimmed">
                <HighlightText value={key} query={query} />
              </Text>
              <ValueView value={value} query={query} />
            </React.Fragment>
          ))}
        </div>
      )}
      {oldKey && newKey && (
        <SimpleGrid
          cols={{ base: 1, md: 2 }}
          spacing="sm"
          className="transcript-diff"
        >
          <div className="transcript-diff-old">
            <Text size="xs" fw={700} mb={6}>
              {t('transcriptBefore')}
            </Text>
            <Code block>
              <HighlightText value={String(args[oldKey] ?? '')} query={query} />
            </Code>
          </div>
          <div className="transcript-diff-new">
            <Text size="xs" fw={700} mb={6}>
              {t('transcriptAfter')}
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
  force,
  query
}: {
  call: ToolCallView
  force: number
  query: string
}): React.JSX.Element {
  const t = useMessages()
  const jump = (): void => {
    if (!call.resultMessageId) return
    scrollToTranscriptElement(`transcript-${call.resultMessageId}`)
  }
  return (
    <Paper withBorder p="sm" className="transcript-tool-call">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconTool size={ICON_SIZE.md} />
          <Text fw={600} size="sm">
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
            {t('transcriptJumpResult')}
          </Button>
        )}
      </Group>
      <Section
        title={t('transcriptArguments')}
        value={JSON.stringify(call.args, null, 2)}
        openedInitially
        force={force}
      >
        <ToolArguments args={call.args} query={query} />
      </Section>
    </Paper>
  )
}

function TranscriptMessage({
  message,
  force,
  query
}: {
  message: TranscriptMessageView
  force: number
  query: string
}): React.JSX.Element {
  const t = useMessages()
  const presentation = rolePresentation(message.role)
  const jumpToCall = (): void => {
    if (!message.toolCallId) return
    scrollToTranscriptElement(`transcript-call-${message.toolCallId}`)
  }
  return (
    <Paper
      id={`transcript-${message.id}`}
      data-transcript-message-key={messageKey(message)}
      withBorder
      className={`transcript-message transcript-${message.role}`}
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
        {message.usage && (
          <Group gap={6} className="transcript-token-metrics">
            {message.usage.total !== undefined && (
              <Tooltip label={message.usage.total.toLocaleString()}>
                <Badge
                  variant="outline"
                  leftSection={<IconCpu size={ICON_SIZE.xs} />}
                >
                  {formatTokens(message.usage.total)}
                </Badge>
              </Tooltip>
            )}
            {(message.usage.input !== undefined ||
              message.usage.output !== undefined) && (
              <Badge variant="outline">
                {t('transcriptTokensIn')} {message.usage.input ?? '—'} ·{' '}
                {t('transcriptTokensOut')} {message.usage.output ?? '—'}
              </Badge>
            )}
            {message.usage.cacheRead !== undefined && (
              <Badge variant="outline">
                {t('transcriptCacheRead')} {message.usage.cacheRead}
              </Badge>
            )}
            {message.usage.cacheCreation !== undefined && (
              <Badge variant="outline">
                {t('transcriptCacheCreation')} {message.usage.cacheCreation}
              </Badge>
            )}
            {message.usage.reasoning !== undefined && (
              <Badge
                variant="outline"
                leftSection={<IconBrain size={ICON_SIZE.xs} />}
              >
                {message.usage.reasoning}
              </Badge>
            )}
          </Group>
        )}
      </Group>
      <div className="transcript-message-body">
        {message.toolArgs && (
          <div className="transcript-linked-call">
            <Group justify="space-between" mb="xs">
              <Text size="xs" fw={700} c="dimmed">
                {t('transcriptCallArguments')}
              </Text>
              <Button
                variant="subtle"
                size="compact-xs"
                leftSection={<IconArrowUp size={ICON_SIZE.sm} />}
                onClick={jumpToCall}
              >
                {t('transcriptJumpCall')}
              </Button>
            </Group>
            <ToolArguments args={message.toolArgs} query={query} />
          </div>
        )}
        {message.reasoning && (
          <Section
            title={t('transcriptReasoning')}
            value={message.reasoning}
            force={force}
            icon={<IconBrain size={ICON_SIZE.sm} />}
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
            title={
              message.role === 'tool'
                ? t('transcriptResult')
                : t('transcriptContent')
            }
            value={message.content}
            openedInitially={
              message.content.length <= 600 && message.role !== 'system'
            }
            force={force}
          >
            {message.role === 'tool' ? (
              <Code block className="transcript-tool-output">
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
        {message.toolCalls.map((call) => (
          <div id={`transcript-call-${call.id}`} key={call.id}>
            <ToolCall call={call} force={force} query={query} />
          </div>
        ))}
        {message.artifact !== undefined && message.artifact !== null && (
          <Section
            title={t('transcriptArtifact')}
            value={JSON.stringify(message.artifact, null, 2)}
            force={force}
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

const ROLES: TranscriptRole[] = [
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

function scrollToTranscriptElement(
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

function messageKey(message: TranscriptMessageView): string {
  return `${message.seq}:${message.id}:${message.role}`
}

function messagePreview(message: TranscriptMessageView): string {
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
      className="transcript-minimap-segment"
      data-current={current ? 'true' : undefined}
      data-preview={preview ? 'true' : undefined}
      style={{ top: `${top}px`, width: `${width}px` }}
    />
  )
})

function TranscriptMinimap({
  messages,
  timelineRef,
  timelineId
}: {
  messages: TranscriptMessageView[]
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
        ':scope > [data-transcript-message-key]'
      )) {
        const message = byKey.get(node.dataset.transcriptMessageKey ?? '')
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
        className="transcript-minimap"
        aria-label={t('transcriptMinimap')}
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
    scrollToTranscriptElement(`transcript-${message.id}`, 'auto')
  }

  return (
    <nav
      className="transcript-minimap"
      aria-label={t('transcriptMinimap')}
      style={{
        height: MINIMAP_HEIGHT,
        top: topOffset ?? `calc(50vh - ${MINIMAP_HEIGHT / 2}px)`
      }}
    >
      <div
        className="transcript-minimap-track"
        role="slider"
        tabIndex={0}
        aria-label={t('transcriptMinimapPosition')}
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
        <div className="transcript-minimap-marks" aria-hidden="true">
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
          className="transcript-minimap-preview"
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

export function TranscriptTimeline({
  events
}: {
  events: TranscriptEvent[]
}): React.JSX.Element {
  const t = useMessages()
  const timelineId = React.useId()
  const narrowTranscript = useMediaQuery(
    `(max-width: ${BREAKPOINTS.rail}px)`,
    false,
    {
      getInitialValueInEffect: false
    }
  )
  const document = React.useMemo(() => normalizeTranscript(events), [events])
  const [query, setQuery] = React.useState('')
  const [roles, setRoles] = React.useState<TranscriptRole[]>(ROLES)
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
  const toggleRole = (role: TranscriptRole): void =>
    setRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : [...current, role]
    )
  const usageParts = [
    document.totalUsage.input === undefined
      ? undefined
      : `${t('transcriptTokensIn')} ${formatTokens(document.totalUsage.input)}`,
    document.totalUsage.output === undefined
      ? undefined
      : `${t('transcriptTokensOut')} ${formatTokens(document.totalUsage.output)}`,
    document.totalUsage.cacheRead === undefined
      ? undefined
      : `${t('transcriptCacheRead')} ${formatTokens(document.totalUsage.cacheRead)}`,
    document.totalUsage.cacheCreation === undefined
      ? undefined
      : `${t('transcriptCacheCreation')} ${formatTokens(document.totalUsage.cacheCreation)}`
  ].filter(Boolean)
  return (
    <Stack gap="md">
      <Paper withBorder p="sm" className="transcript-toolbar">
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
            <Text size="xs" c="dimmed">
              {t('transcriptShowing')
                .replace('{shown}', String(filtered.length))
                .replace('{total}', String(document.messages.length))}
              {document.totalUsage.total !== undefined && (
                <>
                  {' · '}
                  <Tooltip label={document.totalUsage.total.toLocaleString()}>
                    <span>
                      {t('transcriptUsageProcessed').replace(
                        '{count}',
                        formatTokens(document.totalUsage.total)
                      )}
                    </span>
                  </Tooltip>
                </>
              )}
              {usageParts.length > 0 && ` · ${usageParts.join(' · ')}`}
            </Text>
          </Stack>
          <Group gap="xs" wrap="wrap">
            <TextInput
              leftSection={<IconSearch size={ICON_SIZE.sm} />}
              placeholder={t('transcriptSearch')}
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
      <div className="transcript-layout">
        <Stack
          id={timelineId}
          gap="sm"
          className="transcript-timeline"
          ref={timelineRef}
        >
          {filtered.map((message) => (
            <TranscriptMessage
              key={messageKey(message)}
              message={message}
              force={force}
              query={query.trim()}
            />
          ))}
        </Stack>
        {!narrowTranscript && (
          <TranscriptMinimap
            messages={filtered}
            timelineRef={timelineRef}
            timelineId={timelineId}
          />
        )}
      </div>
    </Stack>
  )
}

export function TranscriptViewer({
  target,
  onClose
}: {
  target: TranscriptTarget | undefined
  onClose: () => void
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Modal
      opened={target !== undefined}
      onClose={onClose}
      title={target?.title}
      size="calc(100vw - 64px)"
      classNames={{ body: 'memory-viewer-modal' }}
    >
      <Group justify="end" mb="md">
        {target && (
          <>
            <Button
              component="a"
              href={target.pageHref}
              target="_blank"
              rel="noreferrer"
              variant="default"
              leftSection={<IconExternalLink size={ICON_SIZE.md} />}
            >
              {t('openFullPage')}
            </Button>
            <Button
              component="a"
              href={target.downloadHref}
              download
              variant="default"
              leftSection={<IconDownload size={ICON_SIZE.md} />}
            >
              {t('downloadOriginal')}
            </Button>
          </>
        )}
      </Group>
      {target && <TranscriptContent target={target} />}
    </Modal>
  )
}

export function TranscriptContent({
  target
}: {
  target: TranscriptTarget
}): React.JSX.Element {
  const t = useMessages()
  const [events, setEvents] = React.useState<TranscriptEvent[]>([])
  const [error, setError] = React.useState<unknown>()
  const [loading, setLoading] = React.useState(false)
  const requests = React.useRef(new LatestRequestGuard())
  React.useEffect(() => {
    const request = requests.current.begin()
    setEvents([])
    setLoading(true)
    setError(undefined)
    void api<{ events: TranscriptEvent[] }>(target.contentHref, {
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
        <ResourceLoadError message={t('transcriptLoadFailed')} />
      </div>
    )
  if (loading) return <LoadingState message={t('loading')} />
  return <TranscriptTimeline events={events} />
}
