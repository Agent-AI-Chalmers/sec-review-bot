import React from 'react'
import { Link } from 'react-router-dom'
import {
  Badge,
  Button,
  Drawer,
  Group,
  Paper,
  Stack,
  Text,
  UnstyledButton
} from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

import type { ParkedRun } from './api.js'
import { useMessages } from '../../shared/i18n.js'
import { axisLabel } from './status.js'
import { formatDuration } from './format.js'
import { ICON_SIZE } from '../../shared/design.js'
import { useNow } from '../../shared/useNow.js'

/** The operator queue for runs whose coordination stopped without concluding. */
export function ParkedRuns({
  blocked
}: {
  blocked: ParkedRun[]
}): React.JSX.Element | null {
  const t = useMessages()
  const now = useNow()
  const [opened, setOpened] = React.useState(false)
  if (blocked.length === 0) return null
  const oldestWait = blocked.reduce<number | null>((oldest, block) => {
    const parkedAt = Date.parse(block.parked_at)
    if (!Number.isFinite(parkedAt)) return oldest
    const wait = Math.max(0, now - parkedAt)
    return oldest === null || wait > oldest ? wait : oldest
  }, null)
  return (
    <>
      <Paper
        withBorder
        p="sm"
        mb="md"
        className="parked-runs-summary"
        data-testid="parked-runs"
        role="status"
      >
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Group gap="xs" align="center" wrap="nowrap">
            <IconAlertTriangle size={ICON_SIZE.md} aria-hidden />
            <Text size="sm" fw={600}>
              {t('parkedRunsTitle')}
            </Text>
            <Badge size="sm" color="orange" variant="light">
              {blocked.length}
            </Badge>
            {oldestWait !== null && (
              <Text size="xs" c="dimmed">
                {t('parkedOldest').replace(
                  '{duration}',
                  formatDuration(oldestWait, t)
                )}
              </Text>
            )}
          </Group>
          <Button
            variant="light"
            color="orange"
            size="compact-sm"
            onClick={() => setOpened(true)}
          >
            {t('parkedRunsView')}
          </Button>
        </Group>
      </Paper>
      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        position="right"
        size="lg"
        title={t('parkedRunsTitle')}
      >
        <Stack gap="md">
          <Stack gap={4}>
            <Text size="sm">{t('parkedRunsSummary')}</Text>
            <Text size="sm" c="dimmed">
              {t('parkedRunsBody')}
            </Text>
          </Stack>
          <Stack gap="xl">
            {(['preparation', 'execution', 'publication'] as const).map(
              (axis) => {
                const runs = blocked.filter((block) => block.axis === axis)
                if (runs.length === 0) return null
                return (
                  <Stack gap="sm" key={axis}>
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                      {axisLabel(axis, t)}
                    </Text>
                    {runs.map((block) => {
                      const wait = now - Date.parse(block.parked_at)
                      return (
                        <UnstyledButton
                          key={block.run_id}
                          component={Link}
                          to={`/runs/${encodeURIComponent(block.run_id)}`}
                          className="parked-run-row"
                        >
                          <Text
                            size="sm"
                            ff="monospace"
                            className="parked-run-id"
                          >
                            {block.run_id}
                          </Text>
                          {Number.isFinite(wait) && (
                            <Text size="xs" c="dimmed">
                              {t('parkedAge').replace(
                                '{duration}',
                                formatDuration(Math.max(0, wait), t)
                              )}
                            </Text>
                          )}
                        </UnstyledButton>
                      )
                    })}
                  </Stack>
                )
              }
            )}
          </Stack>
        </Stack>
      </Drawer>
    </>
  )
}
