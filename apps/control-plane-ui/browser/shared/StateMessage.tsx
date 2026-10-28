import React from 'react'
import { Loader, Stack, Text } from '@mantine/core'

/**
 * Shared loading/empty presentation. These states are not errors and do not
 * need the heavier ResourceLoadError card, but they should still look the
 * same everywhere instead of being bare <p> or dimmed text.
 */
export function LoadingState({
  message,
  fill = false
}: {
  message: string
  fill?: boolean
}): React.JSX.Element {
  return (
    <Stack
      align="center"
      justify={fill ? 'center' : undefined}
      gap="sm"
      py={fill ? 0 : 'xl'}
      className={fill ? 'loading-state-fill' : undefined}
      role="status"
    >
      <Loader size="sm" />
      <Text c="dimmed" size="sm">
        {message}
      </Text>
    </Stack>
  )
}

export function EmptyState({
  message,
  icon
}: {
  message: string
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <Stack align="center" gap="xs" py="xl">
      {icon}
      <Text c="dimmed" size="sm" ta="center">
        {message}
      </Text>
    </Stack>
  )
}
