import React from 'react'
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Paper,
  Switch,
  Tooltip
} from '@mantine/core'
import { IconEdit, IconInfoCircle } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import type { MemoryTreeAutomation } from './api-types.generated.js'
import { RefreshControls } from '../../shared/refresh.js'
import { ICON_SIZE } from '../../shared/design.js'

export function MemoryHeader({
  automation,
  activeRevision,
  busy,
  automationLoading,
  treeLoading,
  automationError,
  treeError,
  refresh,
  refreshing,
  lastChecked,
  onToggleAutomation,
  onEdit
}: {
  automation: MemoryTreeAutomation | undefined
  activeRevision: number | undefined
  busy: boolean
  automationLoading: boolean
  treeLoading: boolean
  automationError: string
  treeError: string
  refresh: () => Promise<void>
  refreshing: boolean
  lastChecked: Date | undefined
  onToggleAutomation: () => void
  onEdit: () => void
}): React.JSX.Element {
  const t = useMessages()

  return (
    <Paper withBorder p="md" mb="lg">
      <Group justify="space-between" align="center" wrap="wrap">
        <Group align="center" wrap="wrap">
          <Switch
            checked={automation?.state === 'enabled'}
            disabled={!automation || busy}
            label={t('memoryAutomation')}
            onChange={onToggleAutomation}
          />
          <Tooltip
            label={t('memoryTreeAutomationHelp')}
            multiline
            w={360}
            position="bottom-start"
            events={{ hover: true, focus: true, touch: true }}
          >
            <ActionIcon
              component="span"
              role="img"
              tabIndex={0}
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={t('memoryTreeAutomationHelpLabel')}
            >
              <IconInfoCircle size={ICON_SIZE.md} />
            </ActionIcon>
          </Tooltip>
          <Button
            variant="default"
            leftSection={<IconEdit size={ICON_SIZE.md} />}
            disabled={activeRevision === undefined || treeLoading}
            onClick={onEdit}
          >
            {t('editMemoryTree')}
          </Button>
        </Group>
        <RefreshControls
          refresh={refresh}
          refreshing={refreshing}
          lastChecked={lastChecked}
        />
      </Group>
      {((automationLoading && !automation) ||
        (treeLoading && activeRevision === undefined)) && <p>{t('loading')}</p>}
      {automationError && (
        <Alert color="red" mt="md">
          {automationError}
        </Alert>
      )}
      {treeError && (
        <Alert color="red" mt="md">
          {treeError}
        </Alert>
      )}
    </Paper>
  )
}
