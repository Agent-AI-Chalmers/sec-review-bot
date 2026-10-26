import React from 'react'
import { Alert, Button, Group, Paper, Switch } from '@mantine/core'
import { IconEdit } from '@tabler/icons-react'

import { useMessages } from '../../shared/i18n.js'
import type { components } from './api-types.generated.js'
import { RefreshControls } from '../../shared/refresh.js'

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
          <Button
            variant="default"
            leftSection={<IconEdit size={16} />}
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
