import React from 'react'
import { Stack, Text, ThemeIcon, Title } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

import { useMessages } from './i18n.js'

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
        <IconAlertTriangle size={24} />
      </ThemeIcon>
      <Title order={2} size="h3" ta="center">
        {t('contentUnavailable')}
      </Title>
      <Text c="dimmed" ta="center">
        {message}
      </Text>
      {actions}
    </Stack>
  )
}
