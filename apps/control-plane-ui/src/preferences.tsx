import React from 'react'
import { ActionIcon, Group, MantineProvider, Menu, Tooltip } from '@mantine/core'
import { IconLanguage, IconMoon, IconSun } from '@tabler/icons-react'
import { useLanguage, useMessages } from './i18n.js'

export type Theme = 'light' | 'dark'
export type RefreshInterval = 5000 | 15000 | 30000 | 60000

const PreferencesContext = React.createContext<{
  theme: Theme
  autoRefresh: boolean
  refreshInterval: RefreshInterval
  setTheme: (value: Theme) => void
  setAutoRefresh: (value: boolean) => void
  setRefreshInterval: (value: RefreshInterval) => void
}>({
  theme: 'light',
  autoRefresh: true,
  refreshInterval: 15000,
  setTheme: () => {},
  setAutoRefresh: () => {},
  setRefreshInterval: () => {}
})

const refreshIntervals: RefreshInterval[] = [5000, 15000, 30000, 60000]

export function Preferences({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Keep browser preferences local to this console; they are presentation state,
  // not Control Plane account settings.
  const [theme, setTheme] = React.useState<Theme>(
    () =>
      (localStorage.getItem('ui-theme') as Theme) ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  )
  const [autoRefresh, setAutoRefresh] = React.useState(
    () => localStorage.getItem('ui-auto-refresh') !== 'false'
  )
  const [refreshInterval, setRefreshInterval] = React.useState<RefreshInterval>(() => {
    const stored = Number(localStorage.getItem('ui-refresh-interval'))
    return refreshIntervals.includes(stored as RefreshInterval)
      ? (stored as RefreshInterval)
      : 15000
  })
  React.useEffect(() => {
    localStorage.setItem('ui-theme', theme)
    document.documentElement.dataset.theme = theme
  }, [theme])
  React.useEffect(() => {
    localStorage.setItem('ui-auto-refresh', String(autoRefresh))
  }, [autoRefresh])
  React.useEffect(() => {
    localStorage.setItem('ui-refresh-interval', String(refreshInterval))
  }, [refreshInterval])
  return (
    <PreferencesContext.Provider
      value={{
        theme,
        autoRefresh,
        refreshInterval,
        setTheme,
        setAutoRefresh,
        setRefreshInterval
      }}
    >
      <MantineProvider forceColorScheme={theme}>{children}</MantineProvider>
    </PreferencesContext.Provider>
  )
}

export function usePreferences(): React.ContextType<typeof PreferencesContext> {
  return React.useContext(PreferencesContext)
}

export function PreferenceControls(): React.JSX.Element {
  const { theme, setTheme } = usePreferences()
  const { language, setLanguage } = useLanguage()
  const t = useMessages()
  return (
    <Group gap={4} wrap="nowrap" aria-label="Preferences">
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Tooltip label={t('language')}>
            <ActionIcon variant="subtle" color="gray" aria-label={t('language')}>
              <IconLanguage size={19} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('language')}</Menu.Label>
          <Menu.Item onClick={() => setLanguage('en')} fw={language === 'en' ? 600 : undefined}>
            English
          </Menu.Item>
          <Menu.Item onClick={() => setLanguage('zh')} fw={language === 'zh' ? 600 : undefined}>
            中文
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Tooltip label={theme === 'light' ? t('dark') : t('light')}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('theme')}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? (
            <IconMoon size={19} stroke={1.8} />
          ) : (
            <IconSun size={19} stroke={1.8} />
          )}
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}
