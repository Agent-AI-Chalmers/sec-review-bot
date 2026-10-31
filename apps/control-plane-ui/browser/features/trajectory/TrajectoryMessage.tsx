import React from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Paper,
  Text,
  Tooltip
} from '@mantine/core'
import {
  IconArrowDown,
  IconArrowUp,
  IconBraces,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconMessage,
  IconTool
} from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import type { ToolCallView, TrajectoryMessageView } from './trajectory-model.js'
import { rolePresentation } from './trajectory-roles.js'
import {
  messageKey,
  scrollToTrajectoryElement
} from './trajectory-navigation.js'
import { HighlightText, HighlightedMarkdown } from './TrajectoryText.js'
import { ToolArguments } from './ToolArguments.js'
import { TokenUsagePopover } from './TokenUsagePopover.js'

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

export function TrajectoryMessage({
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
