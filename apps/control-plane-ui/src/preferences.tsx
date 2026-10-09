import React from 'react'
import { ActionIcon, Group, MantineProvider, Menu, Tooltip } from '@mantine/core'
import { IconLanguage, IconMoon, IconSun } from '@tabler/icons-react'

export type Language = 'en' | 'zh'
export type Theme = 'light' | 'dark'
export type RefreshInterval = 5000 | 15000 | 30000 | 60000

const messages = {
  en: {
    language: 'Language',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    signInHint: 'Sign in to inspect review runs.',
    accessToken: 'Access token',
    signIn: 'Sign in',
    denied: 'Access denied.',
    runs: 'Review runs',
    refresh: 'Refresh',
    autoRefresh: 'Auto refresh',
    refreshInterval: 'Refresh interval',
    lastChecked: 'Last checked',
    neverChecked: 'Not checked yet',
    refreshFailed: 'Refresh failed. Showing the last available data.',
    download: 'Download',
    artifactAvailable: 'Available',
    notAvailable: 'Not available',
    sha256: 'SHA-256',
    copyDigest: 'Copy digest',
    digestCopied: 'Digest copied',
    status: 'Status',
    statusPreparing: 'Preparing',
    statusRecovering: 'Recovering',
    statusQueued: 'Queued',
    statusRunning: 'Running',
    statusSucceeded: 'Succeeded',
    statusPublishing: 'Publishing',
    statusPublished: 'Published',
    statusFailed: 'Failed',
    workflow: 'Workflow',
    all: 'All',
    loadingRuns: 'Loading runs...',
    emptyRuns: 'No review runs match these filters.',
    run: 'Run',
    updated: 'Updated',
    nextPage: 'Next page',
    back: 'Back to runs',
    loadingRun: 'Loading run...',
    runProgress: 'Run progress',
    created: 'Created',
    execution: 'Execution',
    publicationPending: 'Pending',
    publicationNotRequired: 'Not required',
    artifact: 'Artifact',
    publication: 'Publication',
    openExternalLink: 'View publication result',
    waiting: 'Waiting',
    publishingStatus: 'Publishing',
    retryPending: 'Retry pending',
    failedStatus: 'Failed',
    failedAttempts: 'Failed attempts',
    latestError: 'Latest error',
    unable: 'Unable to load Control Plane',
    requestFailed: 'The service could not complete this request.'
  },
  zh: {
    language: '语言',
    theme: '主题',
    light: '浅色',
    dark: '深色',
    signInHint: '登录以查看审查运行。',
    accessToken: '访问令牌',
    signIn: '登录',
    denied: '访问被拒绝。',
    runs: '审查运行',
    refresh: '刷新',
    autoRefresh: '自动刷新',
    refreshInterval: '刷新频率',
    lastChecked: '上次检查',
    neverChecked: '尚未检查',
    refreshFailed: '刷新失败，当前显示上次成功获取的数据。',
    download: '下载',
    artifactAvailable: '可用',
    notAvailable: '不可用',
    sha256: 'SHA-256',
    copyDigest: '复制摘要',
    digestCopied: '摘要已复制',
    status: '状态',
    statusPreparing: '准备中',
    statusRecovering: '恢复中',
    statusQueued: '排队中',
    statusRunning: '运行中',
    statusSucceeded: '执行成功',
    statusPublishing: '发布中',
    statusPublished: '已发布',
    statusFailed: '失败',
    workflow: '工作流',
    all: '全部',
    loadingRuns: '正在加载运行...',
    emptyRuns: '没有符合筛选条件的运行。',
    run: '运行',
    updated: '最近更新',
    nextPage: '下一页',
    back: '返回运行列表',
    loadingRun: '正在加载运行...',
    runProgress: '运行进度',
    created: '创建',
    execution: '执行',
    publicationPending: '等待中',
    publicationNotRequired: '无需发布',
    artifact: '产物',
    publication: '发布',
    openExternalLink: '查看发布结果',
    waiting: '等待中',
    publishingStatus: '发布中',
    retryPending: '等待重试',
    failedStatus: '失败',
    failedAttempts: '失败次数',
    latestError: '最近错误',
    unable: '无法加载 Control Plane',
    requestFailed: '服务无法完成此请求。'
  }
} as const
export type Message = keyof typeof messages.en

const PreferencesContext = React.createContext<{
  language: Language
  theme: Theme
  autoRefresh: boolean
  refreshInterval: RefreshInterval
  setLanguage: (value: Language) => void
  setTheme: (value: Theme) => void
  setAutoRefresh: (value: boolean) => void
  setRefreshInterval: (value: RefreshInterval) => void
}>({
  language: 'en',
  theme: 'light',
  autoRefresh: true,
  refreshInterval: 15000,
  setLanguage: () => {},
  setTheme: () => {},
  setAutoRefresh: () => {},
  setRefreshInterval: () => {}
})

const refreshIntervals: RefreshInterval[] = [5000, 15000, 30000, 60000]

export function Preferences({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Keep browser preferences local to this console; they are presentation state,
  // not Control Plane account settings.
  const [language, setLanguage] = React.useState<Language>(
    () =>
      (localStorage.getItem('ui-language') as Language) ||
      (navigator.language.startsWith('zh') ? 'zh' : 'en')
  )
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
    localStorage.setItem('ui-language', language)
  }, [language])
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
        language,
        theme,
        autoRefresh,
        refreshInterval,
        setLanguage,
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
export function useMessages(): (key: Message) => string {
  const { language } = usePreferences()
  return (key) => messages[language][key]
}
export function formatDate(value: string, language: Language): string {
  // Date formatting follows the selected UI language instead of the browser's
  // ambient locale, so an English console cannot unexpectedly show Chinese dates.
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
}
export function PreferenceControls(): React.JSX.Element {
  const { language, theme, setLanguage, setTheme } = usePreferences()
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
