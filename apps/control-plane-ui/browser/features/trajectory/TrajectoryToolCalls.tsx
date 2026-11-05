import React from 'react'
import { Badge, Button, Code, Collapse, Group, Text } from '@mantine/core'
import {
  IconArrowDown,
  IconChevronDown,
  IconChevronRight,
  IconTool
} from '@tabler/icons-react'
import { useMessages } from '../../shared/i18n.js'
import { ICON_SIZE } from '../../shared/design.js'
import type { ToolCallView } from './trajectory-model.js'
import { scrollToTrajectoryElement } from './trajectory-navigation.js'
import { HighlightText } from './TrajectoryText.js'
import { DiffView } from './DiffView.js'
import { ToolArguments } from './ToolArguments.js'

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
    <div
      className="trajectory-tool-call"
      data-result-status={call.resultStatus}
    >
      <Group
        justify="space-between"
        wrap="nowrap"
        className="trajectory-tool-call-header"
      >
        <Group gap="xs" wrap="nowrap" className="trajectory-tool-call-identity">
          <IconTool size={ICON_SIZE.md} color="var(--trajectory-tool-color)" />
          <Text fw={600} size="sm" c="var(--trajectory-tool-color)" truncate>
            <HighlightText value={call.name} query={query} />
          </Text>
          {call.resultStatus === 'error' && (
            <Badge color="red" size="xs" variant="light">
              error
            </Badge>
          )}
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
        {call.diff ? (
          // The tool reported a real diff (context included); prefer it over
          // reconstructing anything from the call arguments.
          <DiffView
            text={call.diff}
            query={query}
            truncated={call.diffTruncated === true}
          />
        ) : Object.keys(call.args).length === 0 ? (
          <Code>{t('trajectoryEmptyArguments')}</Code>
        ) : (
          <ToolArguments args={call.args} query={query} />
        )}
      </div>
    </div>
  )
}

export function TrajectoryToolCalls({
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
            <div id={call.anchorId} key={call.anchorId}>
              <ToolCall call={call} query={query} />
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  )
}
