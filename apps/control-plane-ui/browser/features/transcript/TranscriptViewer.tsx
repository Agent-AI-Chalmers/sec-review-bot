import React from 'react'
import {
  ActionIcon,
  Alert,
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
import { useMessages } from '../../shared/i18n.js'
import { LatestRequestGuard } from '../../shared/latest-request.js'
import {
  normalizeTranscript,
  type ToolCallView,
  type TranscriptEvent,
  type TranscriptMessageView,
  type TranscriptRole
} from './transcript-model.js'

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
        {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
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
      icon: <IconSettings size={17} />,
      key: 'transcriptSystem'
    }
  if (role === 'human')
    return {
      color: 'orange',
      icon: <IconUser size={17} />,
      key: 'transcriptHuman'
    }
  if (role === 'assistant')
    return {
      color: 'blue',
      icon: <IconRobot size={17} />,
      key: 'transcriptAssistant'
    }
  if (role === 'tool')
    return {
      color: 'green',
      icon: <IconTool size={17} />,
      key: 'transcriptTool'
    }
  return {
    color: 'gray',
    icon: <IconSettings size={17} />,
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
              <IconChevronDown size={15} />
            ) : (
              <IconChevronRight size={15} />
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
    document
      .getElementById(`transcript-${call.resultMessageId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  return (
    <Paper withBorder p="sm" className="transcript-tool-call">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <IconTool size={16} />
          <Text fw={600} size="sm">
            <HighlightText value={call.name} query={query} />
          </Text>
        </Group>
        {call.resultMessageId && (
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<IconArrowDown size={14} />}
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
    document
      .getElementById(`transcript-call-${message.toolCallId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  return (
    <Paper
      id={`transcript-${message.id}`}
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
                <Badge variant="outline" leftSection={<IconCpu size={12} />}>
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
              <Badge variant="outline" leftSection={<IconBrain size={12} />}>
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
                leftSection={<IconArrowUp size={14} />}
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
            icon={<IconBrain size={15} />}
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

export function TranscriptTimeline({
  events
}: {
  events: TranscriptEvent[]
}): React.JSX.Element {
  const t = useMessages()
  const document = React.useMemo(() => normalizeTranscript(events), [events])
  const [query, setQuery] = React.useState('')
  const [roles, setRoles] = React.useState<TranscriptRole[]>(ROLES)
  const [force, setForce] = React.useState(0)
  const filtered = document.messages.filter(
    (message) =>
      roles.includes(message.role) &&
      message.searchable.includes(query.trim().toLowerCase())
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
              leftSection={<IconSearch size={15} />}
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
      <Stack gap="sm" className="transcript-timeline">
        {filtered.map((message) => (
          <TranscriptMessage
            key={`${message.id}:${message.seq}:${message.role}`}
            message={message}
            force={force}
            query={query.trim()}
          />
        ))}
      </Stack>
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
              leftSection={<IconExternalLink size={16} />}
            >
              {t('openFullPage')}
            </Button>
            <Button
              component="a"
              href={target.downloadHref}
              download
              variant="default"
              leftSection={<IconDownload size={16} />}
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
    return <Alert color="red">{t('transcriptLoadFailed')}</Alert>
  if (loading) return <Text c="dimmed">{t('loading')}</Text>
  return <TranscriptTimeline events={events} />
}
