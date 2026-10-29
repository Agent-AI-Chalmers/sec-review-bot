import React from 'react'
import { Stack, Text, ThemeIcon, Title } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

import { useMessages } from './i18n.js'
import { ICON_SIZE } from './design.js'

export function ResourceLoadError({
  message,
  actions
}: {
  message: string
  actions?: React.ReactNode
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Stack className="resource-load-error" align="center" gap="sm" role="alert">
      <ThemeIcon color="red" variant="light" size={48} radius="xl">
        <IconAlertTriangle size={ICON_SIZE.xl} />
      </ThemeIcon>
      <Title order={2} size="h3" ta="center">
        {t('contentUnavailable')}
      </Title>
      <Text c="var(--muted)" ta="center">
        {message}
      </Text>
      {actions}
    </Stack>
  )
}
