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
import type { components } from './api-types.generated.js'
import { RefreshControls } from '../../shared/refresh.js'
import { ICON_SIZE } from '../../shared/design.js'

type Control = components['schemas']['MaintenanceControl']

export function MemoryHeader({
  control,
  activeRevision,
  busy,
  controlLoading,
  treeLoading,
  controlError,
  treeError,
  refresh,
  refreshing,
  lastChecked,
  onToggleMaintenance,
  onEdit
}: {
  control: Control | undefined
  activeRevision: number | undefined
  busy: boolean
  controlLoading: boolean
  treeLoading: boolean
  controlError: string
  treeError: string
  refresh: () => Promise<void>
  refreshing: boolean
  lastChecked: Date | undefined
  onToggleMaintenance: () => void
  onEdit: () => void
}): React.JSX.Element {
  const t = useMessages()

  return (
    <Paper withBorder p="md" mb="lg">
      <Group justify="space-between" align="center" wrap="wrap">
        <Group align="center" wrap="wrap">
          <Switch
            checked={control?.state === 'enabled'}
            disabled={!control || busy}
            color="green"
            label={
              control?.state === 'enabled'
                ? t('maintenanceEnabled')
                : control?.state === 'paused'
                  ? t('maintenancePaused')
                  : t('maintenanceLoading')
            }
            onChange={onToggleMaintenance}
          />
          <Tooltip
            label={t('maintenanceControlHelp')}
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
              aria-label={t('maintenanceControlHelpLabel')}
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
      {((controlLoading && !control) ||
        (treeLoading && activeRevision === undefined)) && <p>{t('loading')}</p>}
      {controlError && (
        <Alert color="red" mt="md">
          {controlError}
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
