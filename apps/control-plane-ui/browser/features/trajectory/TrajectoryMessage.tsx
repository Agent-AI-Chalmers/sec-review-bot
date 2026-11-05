import type React from 'react'
import { Badge, Button, Code, Group, Paper, Text } from '@mantine/core'
import { IconArrowUp } from '@tabler/icons-react'
import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import type { TrajectoryMessageView } from './trajectory-model.js'
import { rolePresentation } from './trajectory-roles.js'
import {
  messageKey,
  scrollToTrajectoryElement
} from './trajectory-navigation.js'
import { HighlightText } from './TrajectoryText.js'
import { TokenUsagePopover } from './TokenUsagePopover.js'
import { TrajectorySection } from './TrajectorySection.js'
import { TrajectoryToolCalls } from './TrajectoryToolCalls.js'

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
  const modelLabel = [message.modelProvider, message.modelName]
    .filter(Boolean)
    .join(' · ')
  const primaryLabel =
    [
      message.agent,
      message.source,
      message.role === 'assistant' ? modelLabel : message.name
    ]
      .filter(Boolean)
      .join(' · ') || undefined
  const jumpToCall = (): void => {
    if (!message.requestAnchorId) return
    scrollToTrajectoryElement(message.requestAnchorId)
  }
  return (
    <Paper
      id={`trajectory-${message.id}`}
      data-trajectory-message-key={messageKey(message)}
      data-trajectory-role={message.role}
      data-trajectory-agent={message.agent}
      data-trajectory-source={message.source}
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
          {primaryLabel && (
            <Text
              size="sm"
              c="dimmed"
              fw={message.role === 'assistant' ? 600 : undefined}
            >
              <HighlightText value={primaryLabel} query={query} />
            </Text>
          )}
          {message.status && (
            <Badge
              size="xs"
              {...(message.status === 'error' ? { color: 'red' } : {})}
              variant={message.status === 'error' ? 'light' : 'outline'}
            >
              {message.status}
            </Badge>
          )}
        </Group>
        {(message.requestAnchorId || message.usage) && (
          <Group gap="xs" wrap="wrap">
            {message.requestAnchorId && (
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
          <TrajectorySection
            kind="reasoning"
            title={t('trajectoryReasoning')}
            value={message.reasoning}
            force={force}
            color="violet"
            query={query}
          />
        )}
        {message.repeatedSystemId && (
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() =>
              scrollToTrajectoryElement(
                `trajectory-${message.repeatedSystemId}`
              )
            }
          >
            {t('trajectoryRepeatedSystem')}
          </Button>
        )}
        {message.content && !message.repeatedSystemId && (
          <TrajectorySection
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
            color={message.role === 'tool' ? 'green' : 'blue'}
            query={query}
          >
            {message.role === 'tool' && (
              <Code block className="trajectory-tool-output">
                <HighlightText value={message.content} query={query} />
              </Code>
            )}
          </TrajectorySection>
        )}
        {message.toolCalls.length > 0 && (
          <TrajectoryToolCalls
            calls={message.toolCalls}
            force={force}
            query={query}
          />
        )}
        {message.artifact !== undefined && message.artifact !== null && (
          <TrajectorySection
            kind="artifact"
            title={t('trajectoryArtifact')}
            value={JSON.stringify(message.artifact, null, 2)}
            force={force}
            color="gray"
          >
            <Code block>
              <HighlightText
                value={JSON.stringify(message.artifact, null, 2)}
                query={query}
              />
            </Code>
          </TrajectorySection>
        )}
      </div>
    </Paper>
  )
}
