import React from 'react'
import { Button, Group, Menu, Switch, Text, Tooltip } from '@mantine/core'
import { IconCheck, IconChevronDown, IconRefresh } from '@tabler/icons-react'

import { formatDate, useLanguage, useMessages } from './i18n.js'
import { usePreferences } from '../app/preferences.js'
import { RefreshQueue } from './refresh-queue.js'
import { ICON_SIZE } from './design.js'

export interface RefreshState {
  refresh: () => Promise<void>
  refreshing: boolean
  lastChecked: Date | undefined
}

export function useRefresh(
  load: () => Promise<void>,
  enabled = true
): RefreshState {
  const { autoRefresh, refreshInterval } = usePreferences()
  const [refreshing, setRefreshing] = React.useState(false)
  const [lastChecked, setLastChecked] = React.useState<Date>()
  const loadRef = React.useRef(load)
  loadRef.current = load
  const queueRef = React.useRef<RefreshQueue | null>(null)
  if (queueRef.current === null) {
    queueRef.current = new RefreshQueue(
      () => loadRef.current(),
      setRefreshing,
      () => setLastChecked(new Date())
    )
  }
  const refresh = React.useCallback((): Promise<void> => {
    return queueRef.current!.request()
  }, [])
  React.useEffect(() => {
    void refresh()
  }, [refresh, load])
  React.useEffect(() => {
    if (!autoRefresh || !enabled) return
    const check = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = window.setInterval(check, refreshInterval)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return (): void => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [autoRefresh, enabled, refresh, refreshInterval])
  return { refresh, refreshing, lastChecked }
}

export function RefreshControls({
  refresh,
  refreshing,
  lastChecked,
  autoRefreshEnabled = true
}: RefreshState & { autoRefreshEnabled?: boolean }): React.JSX.Element {
  const { language } = useLanguage()
  const { autoRefresh, refreshInterval, setAutoRefresh, setRefreshInterval } =
    usePreferences()
  const t = useMessages()
  const intervalLabel = (ms: number): string =>
    ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`
  const lastCheckedText = `${t('lastChecked')}: ${
    lastChecked
      ? formatDate(lastChecked.toISOString(), language)
      : t('neverChecked')
  }`
  return (
    // Keep refresh status and preferences together without coupling pages to the app shell.
    <Group gap="sm" wrap="nowrap" className="refresh-controls">
      <Switch
        label={t('autoRefresh')}
        checked={autoRefresh && autoRefreshEnabled}
        disabled={!autoRefreshEnabled}
        onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
      />
      <Tooltip label={lastCheckedText} withArrow>
        <Button.Group>
          <Button
            variant="default"
            leftSection={<IconRefresh size={ICON_SIZE.md} />}
            loading={refreshing}
            onClick={() => void refresh()}
          >
            {t('refresh')}
          </Button>
          <Menu withinPortal position="bottom-end" withArrow>
            <Menu.Target>
              <Button
                variant="default"
                aria-label={t('refreshInterval')}
                px={6}
              >
                <Group gap={2} wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    {intervalLabel(refreshInterval)}
                  </Text>
                  <IconChevronDown size={ICON_SIZE.sm} />
                </Group>
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>
                {t('refreshInterval')}
                {!autoRefresh && ` · ${t('autoRefresh')} off`}
              </Menu.Label>
              {([5000, 15000, 30000, 60000] as const).map((ms) => (
                <Menu.Item
                  key={ms}
                  rightSection={
                    refreshInterval === ms ? (
                      <IconCheck size={ICON_SIZE.sm} />
                    ) : null
                  }
                  onClick={() => setRefreshInterval(ms)}
                >
                  {intervalLabel(ms)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Button.Group>
      </Tooltip>
    </Group>
  )
}
