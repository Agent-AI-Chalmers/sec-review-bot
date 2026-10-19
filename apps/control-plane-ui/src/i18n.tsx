import React from 'react'

export type Language = 'en' | 'zh'

export const messages = {
  en: {
    language: 'Language',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    accessToken: 'Access token',
    signIn: 'Sign in',
    signOut: 'Sign out',
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
    copy: 'Copy',
    copied: 'Copied',
    copyRunId: 'Copy run ID',
    runIdCopied: 'Run ID copied',
    durationDays: 'd',
    durationHours: 'h',
    durationMinutes: 'm',
    durationSeconds: 's',
    ago: 'ago',
    took: 'took',
    artifactAvailable: 'Available',
    artifactUnavailable: 'Unavailable',
    soFar: 'so far:',
    publicationStepSucceeded: 'Succeeded',
    copyDigest: 'Copy digest',
    digestCopied: 'Digest copied',
    expandDigest: 'Show full digest',
    collapseDigest: 'Hide full digest',
    statusPending: 'Pending',
    statusPreparing: 'Preparing',
    statusQueued: 'Queued',
    statusRunning: 'Running',
    statusInProgress: 'In progress',
    statusSucceeded: 'Succeeded',
    statusSubmitted: 'Submitted',
    statusPublishing: 'Publishing',
    statusPublished: 'Published',
    statusDelivering: 'Delivering',
    statusDelivered: 'Delivered',
    statusSkipped: 'Skipped',
    statusUncertain: 'Uncertain',
    observedAgo: 'observed',
    observationStale: 'may be out of date',
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
    perPage: 'Rows per page',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    back: 'Back to runs',
    loadingRun: 'Loading run...',
    runProgress: 'Run progress',
    runHistory: 'History',
    runHistoryEmpty: 'No recorded transitions yet',
    failureCodePreparationRetryExhausted:
      'Preparation kept failing and ran out of retries.',
    failureCodePreparationAbandoned:
      'An operator chose to stop working on this run.',
    failureCodeExecutionAlreadyAdvanced:
      'Preparation gave up after the Runner had already started, so it was left for a person to sort out.',
    failureCodeSubmissionUncertain:
      'The Runner never confirmed whether it accepted the task; the submission can be sent again.',
    failureCodeRunnerExecutionFailed:
      'The Runner reported that the task failed.',
    failureCodeRunnerResultMissing:
      'The Runner reported success without a usable result.',
    failureCodePublicationAbandoned:
      'Publishing stopped because the run will not produce a result.',
    failureCodePublicationStepRetryExhausted:
      'One publishing step kept failing and ran out of retries.',
    failureCodeGithubValidationRejected:
      'GitHub rejected the content this run tried to publish.',
    cancel: 'Cancel',
    blockedRunTitle: 'This run is stuck',
    blockedRunBody:
      'Nothing will move it forward on its own. Decide whether to abandon it, which closes the run and keeps whatever result was recorded.',
    abandonRun: 'Abandon',
    abandonTitle: 'Abandon this run',
    abandonExplainer:
      'This closes the run instead of trying again. Its recorded result is kept, and it cannot be undone.',
    abandonReasonLabel: 'Why are you abandoning it?',
    abandonReasonHint: 'Recorded with the decision so the next person knows.',
    abandonTokenLabel: 'Admin token',
    abandonTokenHint: 'Sent with this one request only. Nothing is stored.',
    abandonConfirm: 'Abandon run',
    abandonWrongToken: 'That admin token was rejected.',
    abandonFailed: 'The run could not be abandoned.',
    blockedPreparationsTitle: 'These runs are stuck',
    blockedPreparationsBody:
      'The system cannot finish them on its own, so it has stopped trying. Someone has to look at each one and decide what should happen.',
    axisExecution: 'Execution',
    axisPreparation: 'Preparation',
    axisPublication: 'Publication',
    axisNotice: 'Failure notice',
    created: 'Created',
    preparation: 'Preparation',
    preparationAttempts: 'Attempts',
    preparationNotice: 'Failure notice',
    execution: 'Execution',
    publication: 'Publication',
    openExternalLink: 'View result',
    retryPending: 'Retry pending',
    failedAttempts: 'Failed attempts',
    failureCode: 'Failure code',
    unable: 'Unable to load Control Plane',
    requestFailed: 'The service could not complete this request.',
    errorTimeout: 'The Control Plane did not respond in time.',
    errorUnreachable: 'The Control Plane is unreachable.',
    errorUpstream: 'The Control Plane returned an error.',
    retry: 'Retry',
    goToRunId: 'Go to run ID',
    runIdPlaceholder: 'Paste a run ID',
    goToRun: 'Go to run',
    runNotFound: 'Run not found',
    runNotFoundHint: 'No run with this ID is stored here.',
    state_preparation_pending_label: 'Pending',
    state_preparation_pending_desc:
      'The run was created, but preparation has not started yet.',
    state_preparation_preparing_label: 'Preparing',
    state_preparation_preparing_desc:
      'Preparing the input that will be sent to the Runner.',
    state_preparation_submitted_label: 'Submitted',
    state_preparation_submitted_desc:
      'The input is ready and has been handed to the Runner. Preparation is done.',
    state_preparation_failed_label: 'Failed',
    state_preparation_failed_desc:
      'Preparation failed for good (retries used up, or the input could not be built). The Runner never received the task, so execution is skipped.',
    state_execution_pending_label: 'Pending',
    state_execution_pending_desc:
      'The run was created and is still being prepared; nothing has been sent to the Runner yet.',
    state_execution_queued_label: 'Queued',
    state_execution_queued_desc:
      'The Runner accepted the task and will start it; it has not started executing yet.',
    state_execution_running_label: 'Running',
    state_execution_running_desc:
      'Polling observed that the Runner is executing this task. A transient network blip while polling does not change this state: the run keeps the last observed value and is polled again, so this state may be a little out of date.',
    state_execution_uncertain_label: 'Uncertain',
    state_execution_uncertain_desc:
      'A submission may have reached the Runner but its result could not be confirmed. A recovery replays the same run_id to find out whether it ran.',
    state_execution_succeeded_label: 'Succeeded',
    state_execution_succeeded_desc:
      'The Runner finished successfully; the result can now be published.',
    state_execution_skipped_label: 'Skipped',
    state_execution_skipped_desc:
      'Execution never ran because preparation failed. This is not an execution failure; the reason is in the preparation step.',
    state_execution_failed_label: 'Failed',
    state_execution_failed_desc:
      'A definite failure, in one of two ways: 1. polling got a conclusive answer that the task cannot succeed — the Runner reported a failure, or the run could not be found, returned no result, or broke the protocol; 2. a retried submission failed conclusively. A transient network error (a timeout, a 5xx, a dropped connection) is not a definite failure.',
    state_publication_pending_label: 'Pending',
    state_publication_pending_desc:
      'Waiting for a successful result before publishing.',
    state_publication_publishing_label: 'Publishing',
    state_publication_publishing_desc:
      'Publishing the result now (creating the pull request, comments, and so on).',
    state_publication_published_label: 'Published',
    state_publication_published_desc:
      'Everything was published successfully; the result is visible.',
    state_publication_failed_label: 'Failed',
    state_publication_failed_desc:
      'Publishing failed after retries were used up.',
    state_publication_skipped_label: 'Skipped',
    state_publication_skipped_desc:
      'Nothing was published because execution did not succeed.',
    machine_preparation_title: 'Preparation',
    machine_execution_title: 'Execution',
    machine_notice_title: 'Failure notice',
    machine_publication_title: 'Publication',
    edge_preparation_pending_preparing:
      'a worker picked up the task and started preparing the input',
    edge_preparation_preparing_submitted:
      'the input is ready and was handed to the Runner',
    edge_preparation_preparing_pending:
      'this attempt failed; it will be retried shortly',
    edge_preparation_preparing_failed:
      'preparation failed for good (retries exhausted, or an error that cannot be retried)',
    edge_execution_pending_queued:
      'the prepared input was submitted and the Runner accepted it',
    edge_execution_pending_skipped:
      'preparation failed, so execution will never run',
    edge_publication_publishing_pending:
      'a step failed but can be retried, so publishing waits and retries',
    edge_publication_publishing_failed:
      'retries were used up, so publishing failed for good',
    edge_publication_pending_skipped:
      'execution did not succeed, so there is nothing to publish',
    edge_publication_publishing_skipped:
      'execution was found to have failed while publishing, so the publication was abandoned',
    edge_execution_pending_uncertain:
      'the submission got no response, so acceptance is unknown',
    edge_execution_uncertain_uncertain:
      'a recovery claim was taken to replay the unconfirmed submission',
    edge_execution_uncertain_queued:
      'the replayed submission was accepted, so the task is queued',
    edge_execution_uncertain_failed:
      'the replayed submission failed conclusively, so the run is failed',
    edge_execution_queued_running: 'polling saw the Runner start the task',
    edge_execution_running_succeeded:
      'polling saw the Runner finish successfully',
    edge_execution_queued_succeeded:
      'polling saw the Runner finish before it was ever seen running',
    edge_execution_queued_failed:
      'polling reached a definite failure (reported failure, run not found, no result, or bad response)',
    edge_execution_running_failed:
      'polling reached a definite failure (reported failure, run not found, no result, or bad response)',
    edge_publication_pending_publishing:
      'a worker started publishing the result',
    edge_publication_publishing_publishing:
      'the publishing claim expired and was taken over to resume publishing',
    edge_publication_publishing_published: 'every publication step succeeded',
    state_notice_pending_label: 'Pending',
    state_notice_pending_desc:
      'A terminal preparation failure happened and the user still has to be told.',
    state_notice_delivering_label: 'Delivering',
    state_notice_delivering_desc:
      'The failure notice is being delivered to the user.',
    state_notice_delivered_label: 'Delivered',
    state_notice_delivered_desc:
      'The user-visible failure notice was delivered.',
    state_notice_skipped_label: 'Skipped',
    state_notice_skipped_desc: 'No notice will be delivered for this failure.',
    edge_notice_pending_delivering:
      'the failure notice was claimed for delivery',
    edge_notice_delivering_delivering:
      'the delivery lease expired, so delivery is retried',
    edge_notice_delivering_delivered:
      'the failure notice was delivered to the user',
    edge_notice_delivering_skipped:
      'no notice will be delivered for this failure',
    stateMachinesTitle: 'State machines',
    failureNoticeLine: 'Failure notice'
  },
  zh: {
    language: '语言',
    theme: '主题',
    light: '浅色',
    dark: '深色',
    accessToken: '访问令牌',
    signIn: '登录',
    signOut: '退出登录',
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
    copy: '复制',
    copied: '已复制',
    copyRunId: '复制 run ID',
    runIdCopied: '已复制 run ID',
    durationDays: '天',
    durationHours: '小时',
    durationMinutes: '分',
    durationSeconds: '秒',
    ago: '前',
    took: '耗时',
    artifactAvailable: '可用',
    artifactUnavailable: '不可用',
    soFar: '已持续',
    publicationStepSucceeded: '发布成功',
    copyDigest: '复制摘要',
    digestCopied: '摘要已复制',
    expandDigest: '显示完整摘要',
    collapseDigest: '收起完整摘要',
    statusPending: '等待中',
    statusPreparing: '准备中',
    statusQueued: '排队中',
    statusRunning: '执行中',
    statusInProgress: '进行中',
    statusSucceeded: '执行成功',
    statusSubmitted: '已提交',
    statusPublishing: '发布中',
    statusPublished: '已发布',
    statusDelivering: '投递中',
    statusDelivered: '已送达',
    statusSkipped: '已跳过',
    statusUncertain: '待确认',
    observedAgo: '观察到',
    observationStale: '可能已过期',
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
    runHistory: '历史',
    runHistoryEmpty: '暂无记录的变更',
    failureCodePreparationRetryExhausted: '准备阶段反复失败，重试次数已用完。',
    failureCodePreparationAbandoned: '有人选择不再继续处理这个 run。',
    failureCodeExecutionAlreadyAdvanced:
      '准备阶段放弃时 Runner 已经开始执行，因此留待人工判断。',
    failureCodeSubmissionUncertain: 'Runner 没有确认是否接单，可以重新提交。',
    failureCodeRunnerExecutionFailed: 'Runner 报告任务执行失败。',
    failureCodeRunnerResultMissing: 'Runner 报告成功，但没有可用的结果。',
    failureCodePublicationAbandoned: '这个 run 不会产出结果，发布已停止。',
    failureCodePublicationStepRetryExhausted:
      '某个发布步骤反复失败，重试次数已用完。',
    failureCodeGithubValidationRejected: 'GitHub 拒绝了这次尝试发布的内容。',
    cancel: '取消',
    blockedRunTitle: '这个 run 卡住了',
    blockedRunBody:
      '系统不会自行推进它了。请判断是否放弃：放弃会结束这个 run，已记录的结果会保留。',
    abandonRun: '放弃',
    abandonTitle: '放弃这个 run',
    abandonExplainer:
      '这会结束这个 run，而不是继续重试。已记录的执行结果会保留，操作不可撤销。',
    abandonReasonLabel: '为什么放弃它？',
    abandonReasonHint: '会随本次决定一起记录，方便后来的人了解原因。',
    abandonTokenLabel: 'Admin token',
    abandonTokenHint: '只随本次请求发送，不会被保存。',
    abandonConfirm: '放弃',
    abandonWrongToken: 'Admin token 被拒绝。',
    abandonFailed: '放弃失败。',
    blockedPreparationsTitle: '这些 run 卡住了',
    blockedPreparationsBody:
      '系统无法自行处理，已经不再重试。需要有人逐个查看并决定怎么处理。',
    axisExecution: '执行',
    axisPreparation: '准备',
    axisPublication: '发布',
    axisNotice: '失败通知',
    created: '创建',
    preparation: '准备',
    preparationAttempts: '尝试次数',
    preparationNotice: '失败通知',
    execution: '执行',
    publication: '发布',
    openExternalLink: '查看结果',
    retryPending: '等待重试',
    failedAttempts: '失败次数',
    failureCode: '失败码',
    unable: '无法加载 Control Plane',
    requestFailed: '服务无法完成此请求。',
    errorTimeout: 'Control Plane 未在规定时间内响应。',
    errorUnreachable: '无法连接到 Control Plane。',
    errorUpstream: 'Control Plane 返回了错误。',
    retry: '重试',
    goToRunId: '按 ID 跳转 run',
    runIdPlaceholder: '粘贴 run ID',
    goToRun: '跳转',
    runNotFound: '找不到该 run',
    runNotFoundHint: '此处没有存储这个 ID 的 run。',
    state_preparation_pending_label: '等待中',
    state_preparation_pending_desc: '任务已创建，但尚未开始准备。',
    state_preparation_preparing_label: '准备中',
    state_preparation_preparing_desc: '正在准备要发送给 Runner 的输入。',
    state_preparation_submitted_label: '已提交',
    state_preparation_submitted_desc:
      '输入已准备好并交给 Runner，准备阶段完成。',
    state_preparation_failed_label: '失败',
    state_preparation_failed_desc:
      '准备最终失败（重试次数用尽，或无法构造输入）。Runner 从未收到任务，因此执行被跳过。',
    state_execution_pending_label: '等待中',
    state_execution_pending_desc: '任务已创建，仍在准备中，尚未发送给 Runner。',
    state_execution_queued_label: '排队中',
    state_execution_queued_desc:
      'Runner 已接受这次提交，但轮询还没观察到它开始执行。',
    state_execution_running_label: '执行中',
    state_execution_running_desc:
      '轮询观察到 Runner 正在执行该任务。轮询时偶发的网络抖动不会改变这个状态：会保留上次观察到的值并继续轮询，因此这个状态可能略有滞后。',
    state_execution_uncertain_label: '待确认',
    state_execution_uncertain_desc:
      '任务已提交，但没有收到响应，因此无法确认 Runner 是否接受。这不是失败；系统会重放这次提交来确认。',
    state_execution_succeeded_label: '执行成功',
    state_execution_succeeded_desc: '轮询观察到执行成功，结果可以发布。',
    state_execution_skipped_label: '已跳过',
    state_execution_skipped_desc:
      '因为准备失败，执行从未运行。这不是执行失败，原因在准备阶段。',
    state_execution_failed_label: '失败',
    state_execution_failed_desc:
      '确定性的失败，分两种情况：1. 轮询得到了“不可能成功”的确定结论：Runner 报告执行失败，或查不到该 run、没有返回结果、响应不符合约定；2. 重放提交得到确定性失败。而网络抖动（超时、5xx、连接中断）不算确定性失败。',
    state_publication_pending_label: '等待中',
    state_publication_pending_desc: '等待执行成功后开始发布。',
    state_publication_publishing_label: '发布中',
    state_publication_publishing_desc:
      '正在把结果发布出去（创建 PR、评论等）。',
    state_publication_published_label: '已发布',
    state_publication_published_desc: '全部发布成功，结果已可见。',
    state_publication_failed_label: '失败',
    state_publication_failed_desc: '重试次数用尽后，发布失败。',
    state_publication_skipped_label: '已跳过',
    state_publication_skipped_desc: '因为执行未成功，没有可发布的内容。',
    machine_preparation_title: '准备',
    machine_execution_title: '执行',
    machine_notice_title: '失败通知',
    machine_publication_title: '发布',
    edge_preparation_pending_preparing: '有执行者接手，开始准备输入',
    edge_preparation_preparing_submitted: '输入构造完成，已交给 Runner',
    edge_preparation_preparing_pending: '本次准备失败，稍后重试',
    edge_preparation_preparing_failed:
      '准备失败（可能是重试次数用尽，也可能是不可重试的错误）',
    edge_execution_pending_queued: '准备好的输入已提交，Runner 接受了该任务',
    edge_execution_pending_skipped: '准备失败，因此执行不会发生',
    edge_publication_publishing_pending: '某步骤失败但可重试，回到等待后重试',
    edge_publication_publishing_failed: '重试次数用尽，发布最终失败',
    edge_publication_pending_skipped: '执行未成功，没有可发布的内容',
    edge_publication_publishing_skipped:
      '发布过程中发现执行已失败，因此放弃发布',
    edge_execution_pending_uncertain: '提交没有收到响应，无法确认是否被接受',
    edge_execution_uncertain_uncertain:
      '取得恢复认领，开始重放这次未确认的提交',
    edge_execution_uncertain_queued: '重放的提交被接受，任务进入队列',
    edge_execution_uncertain_failed: '重放提交得到确定性失败，判定为失败',
    edge_execution_queued_running: '轮询观察到 Runner 开始执行',
    edge_execution_running_succeeded: '轮询观察到 Runner 执行成功',
    edge_execution_queued_succeeded:
      '首次轮询时 Runner 已完成，未观察到执行中状态',
    edge_execution_queued_failed:
      '轮询得到确定性失败（报告失败、查不到 run、无结果或响应不合约定）',
    edge_execution_running_failed:
      '轮询得到确定性失败（报告失败、查不到 run、无结果或响应不合约定）',
    edge_publication_pending_publishing: '开始发布结果',
    edge_publication_publishing_publishing:
      '发布认领过期，被重新接管以继续发布',
    edge_publication_publishing_published: '所有发布步骤均成功',
    state_notice_pending_label: '等待中',
    state_notice_pending_desc: '准备阶段已终态失败，还需要通知用户。',
    state_notice_delivering_label: '投递中',
    state_notice_delivering_desc: '正在把失败通知投递给用户。',
    state_notice_delivered_label: '已送达',
    state_notice_delivered_desc: '用户可见的失败通知已送达。',
    state_notice_skipped_label: '已跳过',
    state_notice_skipped_desc: '这次失败不会投递通知。',
    edge_notice_pending_delivering: '失败通知被领取，开始投递',
    edge_notice_delivering_delivering: '投递租约过期，重新投递',
    edge_notice_delivering_delivered: '失败通知已送达用户',
    edge_notice_delivering_skipped: '这次失败不投递通知',
    stateMachinesTitle: '状态机',
    failureNoticeLine: '失败通知'
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

export function LanguageProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
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

/** Render a timestamp for the console.
 *
 * `hour12: false` is explicit because the two languages disagree by default: en-US formats with
 * AM/PM and zh-CN without, so the same instant read differently in each console language. An
 * operator comparing a Chinese and an English screen (or a log line) must not have to convert
 * between the two, and 24-hour time is the unambiguous form. The date/time component order still
 * follows the language, which is a genuine locale difference rather than an inconsistency.
 */
export function formatDate(value: string, language: Language): string {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}
