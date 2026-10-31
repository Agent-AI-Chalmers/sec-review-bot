import React from 'react'
import {
  Button,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  TextInput
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconSearch } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import { BREAKPOINTS, ICON_SIZE } from '../../shared/design.js'
import {
  normalizeTrajectory,
  type TrajectoryEvent,
  type TrajectoryRole
} from './trajectory-model.js'
import { rolePresentation, TRAJECTORY_ROLES } from './trajectory-roles.js'
import { messageKey } from './trajectory-navigation.js'
import { TrajectoryMessage } from './TrajectoryMessage.js'
import {
  TrajectoryMinimap,
  type MinimapPlacement
} from './TrajectoryMinimap.js'
import { TokenUsagePopover } from './TokenUsagePopover.js'

export function TrajectoryTimeline({
  events,
  minimapPlacement = 'viewport'
}: {
  events: TrajectoryEvent[]
  minimapPlacement?: MinimapPlacement
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
  const [roles, setRoles] = React.useState<TrajectoryRole[]>(TRAJECTORY_ROLES)
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
              {TRAJECTORY_ROLES.map((role) => {
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
        {!narrowTrajectory && minimapPlacement === 'container' && (
          <div className="trajectory-minimap-layer">
            <TrajectoryMinimap
              messages={filtered}
              timelineRef={timelineRef}
              timelineId={timelineId}
              placement="container"
            />
          </div>
        )}
      </div>
      {!narrowTrajectory && minimapPlacement === 'viewport' && (
        <TrajectoryMinimap
          messages={filtered}
          timelineRef={timelineRef}
          timelineId={timelineId}
          placement="viewport"
        />
      )}
    </Stack>
  )
}
