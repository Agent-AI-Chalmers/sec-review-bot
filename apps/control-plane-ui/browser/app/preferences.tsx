import React from 'react'
import {
  ActionIcon,
  Group,
  MantineProvider,
  Menu,
  Tooltip
} from '@mantine/core'
import {
  IconLanguage,
  IconLogout,
  IconMoon,
  IconSun
} from '@tabler/icons-react'
import { logout } from './session-api.js'
import { useLanguage, useMessages } from '../shared/i18n.js'
import { mantineTheme } from './theme.js'

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

/** Fallback only for environments where the custom property cannot be read; the value
 * normally comes from `--theme-transition` in styles.css so the timer and the CSS stay
 * in lockstep instead of being kept in sync by hand. */
const FALLBACK_THEME_TRANSITION_MS = 150

/** Reads `--theme-transition` (e.g. `150ms` / `0.15s`) as milliseconds. The CSS owns the
 * value; this keeps the console's disarm timer exactly as long as the fade it armed. */
function readThemeTransitionMs(root: HTMLElement): number {
  const raw = getComputedStyle(root)
    .getPropertyValue('--theme-transition')
    .trim()
  const match = /^([\d.]+)(ms|s)$/.exec(raw)
  if (match === null) return FALLBACK_THEME_TRANSITION_MS
  const value = Number(match[1])
  return match[2] === 's' ? value * 1000 : value
}

export function Preferences({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  // Keep browser preferences local to this console; they are presentation state,
  // not Review Runs account settings.
  const hasAppliedTheme = React.useRef(false)
  const [theme, setTheme] = React.useState<Theme>(
    () =>
      (localStorage.getItem('ui-theme') as Theme) ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  )
  const [autoRefresh, setAutoRefresh] = React.useState(
    () => localStorage.getItem('ui-auto-refresh') !== 'false'
  )
  const [refreshInterval, setRefreshInterval] = React.useState<RefreshInterval>(
    () => {
      const stored = Number(localStorage.getItem('ui-refresh-interval'))
      return refreshIntervals.includes(stored as RefreshInterval)
        ? (stored as RefreshInterval)
        : 15000
    }
  )
  React.useEffect(() => {
    localStorage.setItem('ui-theme', theme)
    const root = document.documentElement
    // The first run is the stored theme being applied on mount, not a switch the reader
    // made: adding the transition here would fade the console up from the default theme.
    if (!hasAppliedTheme.current) {
      hasAppliedTheme.current = true
      root.dataset.theme = theme
      return
    }
    // Arm the cross-fade only for an actual switch, then disarm so a later, unrelated
    // paint (a route change, a refetch) cannot catch the transition by accident.
    root.classList.add('theme-transition')
    // Force a style flush so the armed transition is in effect *before* the palette
    // changes. Without this the class and the new theme land in one style recalculation
    // and the browser sees no from/to pair to interpolate, so the switch would snap.
    void root.offsetWidth
    root.dataset.theme = theme
    const disarm = (): void => {
      root.classList.remove('theme-transition')
    }
    const timeout = window.setTimeout(disarm, readThemeTransitionMs(root))
    return (): void => {
      window.clearTimeout(timeout)
      disarm()
    }
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
      <MantineProvider theme={mantineTheme} forceColorScheme={theme}>
        {children}
      </MantineProvider>
    </PreferencesContext.Provider>
  )
}

export function usePreferences(): React.ContextType<typeof PreferencesContext> {
  return React.useContext(PreferencesContext)
}

/** `signedIn` only gates sign-out: theme and language are presentation state and stay
 * available on the sign-in form, where they are the reader's only controls. */
export function PreferenceControls({
  signedIn = true
}: {
  signedIn?: boolean
}): React.JSX.Element {
  const { theme, setTheme } = usePreferences()
  const { language, setLanguage } = useLanguage()
  const t = useMessages()
  const [signingOut, setSigningOut] = React.useState(false)
  const signOut = (): void => {
    setSigningOut(true)
    // A full reload drops every cached run in memory. Navigating instead would leave
    // the previous reader's data on screen until the next request failed.
    void logout().then(
      () => window.location.assign('/runs'),
      () => setSigningOut(false)
    )
  }
  return (
    <Group gap={4} wrap="nowrap" aria-label="Preferences">
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Tooltip label={t('language')}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={t('language')}
            >
              <IconLanguage size={19} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('language')}</Menu.Label>
          <Menu.Item
            onClick={() => setLanguage('en')}
            fw={language === 'en' ? 600 : undefined}
          >
            English
          </Menu.Item>
          <Menu.Item
            onClick={() => setLanguage('zh')}
            fw={language === 'zh' ? 600 : undefined}
          >
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
      {signedIn && (
        <Tooltip label={t('signOut')}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t('signOut')}
            loading={signingOut}
            onClick={signOut}
          >
            <IconLogout size={19} stroke={1.8} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  )
}
