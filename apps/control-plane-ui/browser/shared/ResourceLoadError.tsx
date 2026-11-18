import React from 'react'
import { Stack, Text, ThemeIcon, Title } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

import { useMessages } from './i18n.js'
import { ICON_SIZE } from './design.js'

export function ResourceLoadError({
  message,
  actions,
  title,
  fill = false
}: {
  message: string
  title?: string
  fill?: boolean
  actions?: React.ReactNode
}): React.JSX.Element {
  const t = useMessages()
  return (
    <Stack
      className={fill ? 'resource-load-error resource-load-error-fill' : 'resource-load-error'}
      align="center"
      gap="sm"
      role="alert"
    >
      <ThemeIcon color="gray" variant="light" size={48} radius="xl">
        <IconAlertTriangle size={ICON_SIZE.xl} />
      </ThemeIcon>
      <Title order={2} size="h3" ta="center">
        {title ?? t('contentUnavailable')}
      </Title>
      <Text c="var(--muted)" ta="center">
        {message}
      </Text>
      {actions}
    </Stack>
  )
}
