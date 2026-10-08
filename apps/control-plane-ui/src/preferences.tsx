import React from 'react'

export type Language = 'en' | 'zh'
export type Theme = 'light' | 'dark'
export type ColorVision = 'default' | 'friendly'

const messages = {
  en: {
    language: 'Language',
    theme: 'Theme',
    colors: 'Color vision',
    light: 'Light',
    dark: 'Dark',
    default: 'Default',
    friendly: 'Color friendly',
    signInHint: 'Sign in to inspect review runs.',
    accessToken: 'Access token',
    signIn: 'Sign in',
    denied: 'Access denied.',
    runs: 'Review runs',
    refresh: 'Refresh',
    status: 'Status',
    workflow: 'Workflow',
    all: 'All',
    loadingRuns: 'Loading runs...',
    emptyRuns: 'No review runs match these filters.',
    run: 'Run',
    updated: 'Updated',
    nextPage: 'Next page',
    back: 'Back to runs',
    loadingRun: 'Loading run...',
    execution: 'Execution',
    created: 'Created',
    published: 'Published',
    notPublished: 'Not published',
    failure: 'Failure',
    artifact: 'Artifact',
    noArtifact: 'No artifact publication recorded.',
    publicationSteps: 'Publication steps',
    noSteps: 'No publication steps recorded.',
    step: 'Step',
    attempts: 'Attempts',
    none: 'None',
    unable: 'Unable to load Control Plane',
    requestFailed: 'The service could not complete this request.'
  },
  zh: {
    language: '语言',
    theme: '主题',
    colors: '色觉方案',
    light: '浅色',
    dark: '深色',
    default: '默认',
    friendly: '色觉友好',
    signInHint: '登录以查看审查运行。',
    accessToken: '访问令牌',
    signIn: '登录',
    denied: '访问被拒绝。',
    runs: '审查运行',
    refresh: '刷新',
    status: '状态',
    workflow: '工作流',
    all: '全部',
    loadingRuns: '正在加载运行...',
    emptyRuns: '没有符合筛选条件的运行。',
    run: '运行',
    updated: '更新时间',
    nextPage: '下一页',
    back: '返回运行列表',
    loadingRun: '正在加载运行...',
    execution: '执行',
    created: '创建时间',
    published: '发布时间',
    notPublished: '尚未发布',
    failure: '失败',
    artifact: 'Artifact',
    noArtifact: '没有记录 artifact 发布信息。',
    publicationSteps: '发布步骤',
    noSteps: '没有记录发布步骤。',
    step: '步骤',
    attempts: '尝试次数',
    none: '无',
    unable: '无法加载 Control Plane',
    requestFailed: '服务无法完成此请求。'
  }
} as const
export type Message = keyof typeof messages.en

const PreferencesContext = React.createContext<{
  language: Language
  theme: Theme
  colorVision: ColorVision
  setLanguage: (value: Language) => void
  setTheme: (value: Theme) => void
  setColorVision: (value: ColorVision) => void
}>({
  language: 'en',
  theme: 'light',
  colorVision: 'default',
  setLanguage: () => {},
  setTheme: () => {},
  setColorVision: () => {}
})

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
  const [colorVision, setColorVision] = React.useState<ColorVision>(
    () => (localStorage.getItem('ui-color-vision') as ColorVision) || 'default'
  )
  React.useEffect(() => {
    localStorage.setItem('ui-language', language)
  }, [language])
  React.useEffect(() => {
    localStorage.setItem('ui-theme', theme)
    document.documentElement.dataset.theme = theme
  }, [theme])
  React.useEffect(() => {
    localStorage.setItem('ui-color-vision', colorVision)
    document.documentElement.dataset.colorVision = colorVision
  }, [colorVision])
  return (
    <PreferencesContext.Provider
      value={{ language, theme, colorVision, setLanguage, setTheme, setColorVision }}
    >
      {children}
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
  const { language, theme, colorVision, setLanguage, setTheme, setColorVision } = usePreferences()
  const t = useMessages()
  return (
    <div className="preferences" aria-label="Preferences">
      <label>
        {t('language')}
        <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </label>
      <label>
        {t('theme')}
        <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
          <option value="light">{t('light')}</option>
          <option value="dark">{t('dark')}</option>
        </select>
      </label>
      <label>
        {t('colors')}
        <select
          value={colorVision}
          onChange={(event) => setColorVision(event.target.value as ColorVision)}
        >
          <option value="default">{t('default')}</option>
          <option value="friendly">{t('friendly')}</option>
        </select>
      </label>
    </div>
  )
}
