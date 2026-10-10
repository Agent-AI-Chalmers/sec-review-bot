import React from 'react'

export type Language = 'en' | 'zh'

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
    runs: 'Runs',
    refresh: 'Refresh',
    autoRefresh: 'Auto refresh',
    refreshInterval: 'Refresh interval',
    lastChecked: 'Last checked',
    neverChecked: 'Not checked yet',
    refreshFailed: 'Refresh failed. Showing the last available data.',
    download: 'Download',
    sha256: 'SHA-256',
    copyDigest: 'Copy digest',
    digestCopied: 'Digest copied',
    expandDigest: 'Show full digest',
    collapseDigest: 'Hide full digest',
    statusPreparing: 'Preparing',
    statusRecovering: 'Recovering',
    statusQueued: 'Queued',
    statusRunning: 'Running',
    statusSucceeded: 'Succeeded',
    statusPublished: 'Published',
    statusFailed: 'Failed',
    workflow: 'Workflow',
    workflowIssueReview: 'Issue review',
    workflowPullRequestReview: 'Pull request review',
    workflowRepositoryReview: 'Repository review',
    all: 'All',
    loadingRuns: 'Loading runs...',
    emptyRuns: 'No results match these filters',
    run: 'Run',
    lastActivity: 'Last activity',
    timeRange: 'Time range',
    lastHour: 'Last hour',
    lastDay: 'Last 24 hours',
    lastWeek: 'Last 7 days',
    perPage: 'Per page',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    back: 'Back to runs',
    loadingRun: 'Loading run...',
    runProgress: 'Run progress',
    created: 'Created',
    execution: 'Execution',
    publicationPending: 'Pending',
    publicationNotRequired: 'Not required',
    publication: 'Publication',
    openExternalLink: 'View result',
    publishingStatus: 'Publishing',
    retryPending: 'Retry pending',
    failedStatus: 'Failed',
    failedAttempts: 'Failed attempts',
    failureCode: 'Failure code',
    unable: 'Unable to load Control Plane',
    requestFailed: 'The service could not complete this request.',
    retry: 'Retry'
  },
  zh: {
    language: '语言',
    theme: '主题',
    light: '浅色',
    dark: '深色',
    signInHint: '登录以查看审查 run。',
    accessToken: '访问令牌',
    signIn: '登录',
    denied: '访问被拒绝。',
    runs: 'Runs',
    refresh: '刷新',
    autoRefresh: '自动刷新',
    refreshInterval: '刷新频率',
    lastChecked: '上次检查',
    neverChecked: '尚未检查',
    refreshFailed: '刷新失败，当前显示上次成功获取的数据。',
    download: '下载',
    sha256: 'SHA-256',
    copyDigest: '复制摘要',
    digestCopied: '摘要已复制',
    expandDigest: '显示完整摘要',
    collapseDigest: '收起完整摘要',
    statusPreparing: '准备中',
    statusRecovering: '恢复中',
    statusQueued: '排队中',
    statusRunning: '运行中',
    statusSucceeded: '执行成功',
    statusPublished: '已发布',
    statusFailed: '失败',
    workflow: '工作流',
    workflowIssueReview: 'Issue 审查',
    workflowPullRequestReview: 'PR 审查',
    workflowRepositoryReview: '仓库审查',
    all: '全部',
    loadingRuns: '正在加载 run...',
    emptyRuns: '没有符合筛选条件的结果',
    run: 'Run',
    lastActivity: '最后活动',
    timeRange: '时间范围',
    lastHour: '最近 1 小时',
    lastDay: '最近 24 小时',
    lastWeek: '最近 7 天',
    perPage: '每页',
    previousPage: '上一页',
    nextPage: '下一页',
    back: '返回 run 列表',
    loadingRun: '正在加载 run...',
    runProgress: 'Run 进度',
    created: '创建',
    execution: '执行',
    publicationPending: '等待中',
    publicationNotRequired: '无需发布',
    publication: '发布',
    openExternalLink: '查看结果',
    publishingStatus: '发布中',
    retryPending: '等待重试',
    failedStatus: '失败',
    failedAttempts: '失败次数',
    failureCode: '失败码',
    unable: '无法加载 Control Plane',
    requestFailed: '服务无法完成此请求。',
    retry: '重试'
  }
} as const
export type Message = keyof typeof messages.en

const LanguageContext = React.createContext<{
  language: Language
  setLanguage: (value: Language) => void
}>({
  language: 'en',
  setLanguage: () => {}
})

export function LanguageProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Keep the selected UI language local to this console; it is presentation
  // state, not Control Plane account settings.
  const [language, setLanguage] = React.useState<Language>(
    () =>
      (localStorage.getItem('ui-language') as Language) ||
      (navigator.language.startsWith('zh') ? 'zh' : 'en')
  )
  React.useEffect(() => {
    localStorage.setItem('ui-language', language)
    document.documentElement.lang = language
  }, [language])
  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): React.ContextType<typeof LanguageContext> {
  return React.useContext(LanguageContext)
}

export function useMessages(): (key: Message) => string {
  const { language } = useLanguage()
  return (key) => messages[language][key]
}

export function formatDate(value: string, language: Language): string {
  // Date formatting follows the selected UI language instead of the browser's
  // ambient locale, so an English console cannot unexpectedly show Chinese dates.
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
}
