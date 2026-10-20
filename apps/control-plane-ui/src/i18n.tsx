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
    statusDisconnected: 'Disconnected',
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
    // Each sentence states what the code itself means - the fact it names and its consequence.
    // What the system did about it, and what an operator can choose, belongs to the state and the
    // banner around this code; repeating it here says the same thing twice and puts decisions
    // into a vocabulary that is supposed to name facts.
    failureCodePreparationAbandoned:
      'An operator ended this run instead of letting it continue, so its preparation was concluded as failed.',
    failureCodeExecutionAlreadyAdvanced:
      'The preparation claim expired while execution was already past pending. A preparation failure means the task never started, which this run contradicts, so the expiry could not be concluded.',
    failureCodeSubmissionUncertain:
      'The Runner never confirmed whether it accepted the task.',
    failureCodeSubmissionRecoveryExhausted:
      'Replays of the submission kept ending without an answer from the Runner, so its acceptance is still unknown.',
    failureCodeSubmissionRecoveryAbandoned:
      'An operator stopped waiting for this outcome. The Runner may still have accepted and run this task.',
    failureCodePreparationGivenUp:
      'An operator stopped waiting for this preparation.',
    failureCodePublicationGivenUp:
      'An operator stopped publishing while a step could not be confirmed; that step may already have taken effect on GitHub.',
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
    blockedRunTitle: 'This run needs your review',
    // Reason-agnostic on purpose. The banner states the situation and the choices, which are the
    // same whatever stopped the run; the specific conflict belongs to the reason code below it,
    // where each code carries its own sentence. Writing one cause into this slot teaches the
    // operator a false explanation as soon as a second reason exists.
    blockedRunBody:
      'The system stopped here and needs you to decide. It cannot go on, because the conclusion it would draw contradicts something this run has already recorded. The code below says what.',
    blockedNoResumeReason:
      'Resuming is not offered: execution has already moved past the point where preparation could be picked up again, so a resumed preparation could never be claimed.',
    // These describe what the decision does, and each is rendered only for the data it is true
    // of: the stop clause depends on execution actually still moving, and the promise that a
    // resumed run "returns here" is dropped - that is a prediction about a future failure,
    // and the banner already leaves the judgement to the operator.
    blockedOutcomeResume:
      'Resume tries again: preparation goes back to Uncertain with a fresh budget, and the result already recorded is kept.',
    blockedOutcomeAbandon:
      'Abandon gives up on it: preparation is recorded as failed and the result is no longer published. Its recorded result is kept as evidence.',
    blockedOutcomeAbandonStopsExecution:
      'The task is still in flight, so it is stopped too.',
    abandonRun: 'Abandon',
    abandonTitle: 'Abandon this run',
    abandonExplainer:
      'This closes the run instead of trying again, and it cannot be undone.',
    abandonExplainerKeepsResult:
      'The result it already recorded is kept as evidence.',
    abandonReasonLabel: 'Why are you abandoning it?',
    abandonReasonHint: 'Recorded with the decision so the next person knows.',
    abandonTokenLabel: 'Admin token',
    abandonTokenHint: 'Sent with this one request only. Nothing is stored.',
    abandonConfirm: 'Abandon run',
    abandonWrongToken: 'That admin token was rejected.',
    abandonFailed: 'The run could not be abandoned.',
    disconnectedExecutionTitle: 'This run cannot continue on its own',
    disconnectedExecutionBody:
      'Automatic replays of this task ran out without a conclusive answer from the Runner, so the system stopped and will not try again on its own. It is not known whether the Runner accepted this task. Resuming grants a fresh replay budget; abandoning ends the run.',
    disconnectedExecutionOutcomeResume:
      'Resume grants a fresh replay budget so the system can try to establish the outcome again. There is no way to abandon a run in this state yet.',
    disconnectedPublicationTitle: 'This run needs your review',
    disconnectedPublicationBody:
      'Publishing stopped on a step whose result could not be confirmed. Some of this run may already exist on GitHub, and nothing automatic will establish which, so the decision is yours.',
    disconnectedPublicationOutcomeResume:
      'Resume claims the publication again so it is attempted once more. The step that could not be confirmed is then settled as failed rather than run again, so no side effect is repeated.',
    disconnectedPublicationOutcomeGiveUp:
      'Giving up stops publishing: the run is concluded as failed, and whatever already exists on GitHub stays there.',
    giveUpRun: 'Give up',
    giveUpTitle: 'Stop waiting for this outcome',
    giveUpExplainer:
      'This stops waiting, without claiming that nothing happened. The Runner may still have accepted and run this task, or some publishing steps may already exist on GitHub. This run will not wait for the result any longer and will not publish anything more. Whatever already happened remotely stays there. This cannot be undone.',
    giveUpConfirm: 'Stop waiting',
    disconnectedExecutionOutcomeGiveUp:
      'Giving up stops waiting for the result: the task is recorded as failed with a reason naming this decision, and nothing is published. The Runner may still be running it.',
    resumeRun: 'Resume',
    resumeTitle: 'Resume this run',
    resumeExplainer:
      'This hands the run back to automatic recovery instead of ending it. A disconnected preparation returns to Uncertain with a fresh attempt budget, so recovery can establish what the previous attempt left behind. A disconnected publication is claimed again and published once more; a step whose reconciliation already ran out is then settled as failed rather than run again. If the same contradiction is still there, the run stops here again.',
    resumeConfirm: 'Resume run',
    sessionExpired: 'Your session expired. Sign in again, then retry.',
    parkedRunsTitle: 'These runs need your review',
    parkedRunsBody:
      'Automatic work stopped on each of these runs and will not continue by itself. The axis that stopped is named beside each one, because the accepted decisions differ: a run parked on preparation can be resumed only while its execution has not started, while a run parked on execution or publication can be resumed or given up. Opening a run shows the decision the server accepts for it.',
    axisExecution: 'Execution',
    axisPreparation: 'Preparation',
    axisPublication: 'Publication',
    created: 'Created',
    preparation: 'Preparation',
    preparationAttempts: 'Attempts',
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
      'The run was created, but no preparer has taken the work yet: nothing is happening to this run until one does.',
    state_preparation_preparing_label: 'Preparing',
    state_preparation_preparing_desc:
      'Preparing the input that will be sent to the Runner.',
    state_preparation_uncertain_label: 'Uncertain',
    state_preparation_uncertain_desc:
      'The preparer\u2019s claim lapsed before it reported, so it is unknown whether the prepared input reached Control Plane. This is not a failure: the input can be rebuilt and resubmitted under the same identity.',
    state_preparation_disconnected_label: 'Disconnected',
    state_preparation_disconnected_desc:
      'Automatic work stopped because this run\u2019s own records no longer admit the transition expiry could make. Nothing retries it on its own.',
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
    state_execution_disconnected_label: 'Disconnected',
    state_execution_disconnected_desc:
      'Automatic replays ran out without a conclusive Runner answer. Automation has stopped and will not retry by itself; this is not a failure, and an operator has to establish whether the Runner actually has this task.',
    state_execution_succeeded_label: 'Succeeded',
    state_execution_succeeded_desc:
      'The Runner finished successfully; the result can now be published.',
    state_execution_skipped_label: 'Skipped',
    state_execution_skipped_desc:
      'Execution never ran because preparation failed, so there is nothing to execute. The reason lives on the preparation axis; this axis is concluded, not waiting.',
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
    state_publication_uncertain_label: 'Uncertain',
    state_publication_uncertain_desc:
      'At least one step may have completed its side effect remotely and is being reconciled. The rest of the publication is unaffected; this is not a failure.',
    state_publication_disconnected_label: 'Disconnected',
    state_publication_disconnected_desc:
      'Automatic reconciliation of a step stopped without an answer. An operator has to establish what is actually on the remote system before this run can be concluded.',
    state_publication_published_desc:
      'Everything was published successfully; the result is visible.',
    state_publication_failed_label: 'Failed',
    state_publication_failed_desc:
      'Publishing failed for good: a retryable failure returns to Pending instead, so only a conclusive failure or an operator decision stops here.',
    state_publication_skipped_label: 'Skipped',
    state_publication_skipped_desc:
      'Nothing was published because execution did not succeed.',
    machine_preparation_title: 'Preparation',
    machine_execution_title: 'Execution',
    machine_publication_title: 'Publication',
    edge_preparation_pending_preparing:
      'a worker picked up the task and started preparing the input',
    edge_preparation_preparing_submitted:
      'the input is ready and was handed to the Runner',
    edge_preparation_preparing_pending:
      'this attempt failed; it will be retried shortly',
    edge_preparation_preparing_uncertain:
      'the claim lapsed before the preparer reported',
    edge_preparation_uncertain_preparing:
      'a preparer claims it again to establish what was done',
    edge_preparation_preparing_disconnected:
      'the run\u2019s own records contradict concluding it automatically',
    edge_preparation_disconnected_uncertain:
      'an operator handed it back to automatic recovery',
    // The edge key is the pair, and this axis has three operator decisions that agree on the
    // pair (the contract separates them by reason). The wording therefore names what all three
    // have in common: a person concluded a row automation refused to, without claiming that
    // nothing happened. The per-decision wording is on the run's notice and timeline.
    edge_preparation_disconnected_failed:
      'an operator concluded the run instead of waiting for it',
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
      'a recovery claim was taken to replay the unconfirmed submission (the state itself does not change; the timeline records when it happened)',
    edge_execution_uncertain_queued:
      'the replayed submission was accepted, so the task is queued',
    edge_execution_uncertain_failed:
      'the replayed submission failed conclusively, so the run is failed',
    edge_execution_uncertain_disconnected:
      'replays ran out without an answer, so automation stops',
    edge_execution_disconnected_uncertain:
      'an operator handed it back to automatic replay with a fresh budget',
    edge_execution_disconnected_failed:
      'an operator stopped waiting for the result (it may still be running)',
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
    edge_publication_publishing_uncertain:
      'a step may have taken effect remotely',
    edge_publication_uncertain_publishing:
      'the step was settled, so publishing continues',
    edge_publication_uncertain_disconnected:
      'reconciliation could not conclude',
    edge_publication_disconnected_uncertain:
      'an operator handed it back to reconciliation with a fresh budget',
    edge_publication_disconnected_failed:
      'an operator stopped publishing (some steps may already exist)',
    stateMachinesTitle: 'State machines',
    failureNoticeDelivered: 'The requester was told this run failed',
    viewFailureNotice: 'View the failure notice',
    viewAttentionNotice: 'View the outcome-confirmation notice',
    failureNoticeNotDelivered:
      'The requester could not be told: the notice never reached GitHub',
    failureNoticeDelivering: 'Telling the requester that this run failed',
    attentionNoticeDelivered:
      'The requester was told this outcome needs confirmation',
    attentionNoticeNotDelivered:
      'The requester could not be told that this outcome needs confirmation',
    attentionNoticeDelivering:
      'Telling the requester that this outcome needs confirmation'
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
    statusDisconnected: '失联',
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
    // 每条只说这个码本身的意思：它命名的事实，以及这件事的后果。系统怎么处理、operator 能怎么选，
    // 属于状态和它周围的横幅；在这里重复会把同一件事说两遍，也会把“决定”塞进一个本该只命名事实的词表里。
    failureCodePreparationAbandoned:
      '有人主动结束了这个 run，没有让它继续下去，因此准备阶段按失败收尾。',
    failureCodeExecutionAlreadyAdvanced:
      '准备阶段的认领过期时，执行已经不在「等待中」。准备失败意味着任务从未开始，而这个 run 与这一点相矛盾，因此这次过期无法收尾。',
    failureCodeSubmissionUncertain: 'Runner 没有确认是否接单。',
    failureCodeSubmissionRecoveryExhausted:
      '提交的重放一直没有得到 Runner 的答复，因此它是否被接受仍然未知。',
    failureCodeSubmissionRecoveryAbandoned:
      'operator 决定不再等待这个结果。Runner 可能已经接受并执行了这个任务。',
    failureCodePreparationGivenUp: 'operator 决定不再等待这次准备。',
    failureCodePublicationGivenUp:
      '某个步骤无法确认时，operator 决定停止发布；该步骤可能已经在 GitHub 上生效。',
    failureCodeRunnerExecutionFailed: 'Runner 报告任务执行失败。',
    failureCodeRunnerResultMissing: 'Runner 报告成功，但没有可用的结果。',
    failureCodePublicationAbandoned: '这个 run 不会产出结果，发布已停止。',
    failureCodePublicationStepRetryExhausted:
      '某个发布步骤反复失败，重试次数已用完。',
    failureCodeGithubValidationRejected: 'GitHub 拒绝了这次尝试发布的内容。',
    cancel: '取消',
    blockedRunTitle: '这个 run 需要你审计',
    blockedRunBody:
      '系统停在这里，需要你来决定。它没法继续，因为它要下的结论和这个 run 已经记录的东西相矛盾。具体是什么，见下方的代码。',
    blockedNoResumeReason:
      '不提供「恢复」：执行已经走过准备阶段能再次接手的那一点，所以恢复出来的准备永远轮不到接手。',
    blockedOutcomeResume:
      '「恢复」是再试一次：准备阶段回到「待确认」并获得新的尝试预算，已记录的结果不会丢失。',
    blockedOutcomeAbandon:
      '「放弃」是不再尝试：准备记为失败，结果不再发布，已记录的结果作为证据保留。',
    blockedOutcomeAbandonStopsExecution: '该任务仍在执行中，会一并停止。',
    abandonRun: '放弃',
    abandonTitle: '放弃这个 run',
    abandonExplainer: '这会结束这个 run，而不是继续重试，操作不可撤销。',
    abandonExplainerKeepsResult: '它已经记录的结果会作为证据保留。',
    abandonReasonLabel: '为什么放弃它？',
    abandonReasonHint: '会随本次决定一起记录，方便后来的人了解原因。',
    abandonTokenLabel: 'Admin token',
    abandonTokenHint: '只随本次请求发送，不会被保存。',
    abandonConfirm: '放弃',
    abandonWrongToken: 'Admin token 被拒绝。',
    abandonFailed: '放弃失败。',
    disconnectedExecutionTitle: '这个 run 无法自行继续',
    disconnectedExecutionBody:
      '这个任务的自动重放已用尽次数，仍未得到 Runner 的确定答复，因此系统停手，不再自动重试。Runner 到底有没有接受这个任务，目前不得而知。恢复会给予新的重放预算；放弃则会结束这个 run。',
    disconnectedExecutionOutcomeResume:
      '「恢复」会给予新的重放预算，让系统再尝试确认结果。目前这个状态还没有「放弃」的选项。',
    disconnectedPublicationTitle: '这个 run 需要你审计',
    disconnectedPublicationBody:
      '某个步骤的结果无法确认，发布停在了那里。这个 run 的部分内容可能已经出现在 GitHub 上，而不会有任何自动处理去查明到底是哪些，因此需要你来决定。',
    disconnectedPublicationOutcomeResume:
      '「恢复」会重新认领这次发布，再尝试一次。无法确认的那个步骤会被判为失败，而不会再执行一遍，所以不会重复产生副作用。',
    disconnectedPublicationOutcomeGiveUp:
      '「放弃」是不再发布：这个 run 以失败收尾，已经存在于 GitHub 上的内容保持原样。',
    giveUpRun: '放弃',
    giveUpTitle: '不再等待这个结果',
    giveUpExplainer:
      '这表示不再等待，但并不宣称什么都没发生。Runner 可能已经接受并执行了这个任务，也可能已经有部分发布步骤出现在 GitHub 上。这个 run 不再等待结果，也不会再发布任何内容；远端已经发生的事会留在那里。此操作不可撤销。',
    giveUpConfirm: '不再等待',
    disconnectedExecutionOutcomeGiveUp:
      '「放弃」是不再等待结果：该任务会记为失败，并注明这是本次决定所致，不发布任何内容。Runner 那边可能仍在执行。',
    resumeRun: '恢复',
    resumeTitle: '恢复这个 run',
    resumeExplainer:
      '这会把 run 交回自动流程，而不是结束它。失联的准备阶段会回到「待确认」并获得新的尝试预算，由自动恢复查明上一次尝试留下了什么。失联的发布会被重新认领并再发布一次；其中对账次数已耗尽的步骤会被判为失败，而不会再执行一遍。如果同一处矛盾仍然存在，run 会再次停在这里。',
    resumeConfirm: '恢复',
    sessionExpired: '会话已过期。请重新登录后再试。',
    parkedRunsTitle: '这些 run 需要你审计',
    parkedRunsBody:
      '这些 run 的自动处理都已停下，不会自行继续。每条旁边标明了停下的是哪一轴，因为服务端接受的决定取决于这一轴：停在准备轴的 run 只有在执行尚未开始时才能恢复，停在执行轴或发布轴的 run 可以恢复，也可以放弃。打开某个 run 可以看到服务端接受的决定。',
    axisExecution: '执行',
    axisPreparation: '准备',
    axisPublication: '发布',
    created: '创建',
    preparation: '准备',
    preparationAttempts: '尝试次数',
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
    state_preparation_pending_desc:
      '任务已创建，但还没有执行者接手：在有人接手之前，这个 run 不会有任何进展。',
    state_preparation_preparing_label: '准备中',
    state_preparation_preparing_desc: '正在准备要发送给 Runner 的输入。',
    state_preparation_uncertain_label: '待确认',
    state_preparation_uncertain_desc:
      '准备者的认领在回报之前就过期了，因此不确定准备好的输入是否已经到达 Control Plane。这不是失败：可以用同一身份重建输入并重新提交。',
    state_preparation_disconnected_label: '失联',
    state_preparation_disconnected_desc:
      '这个 run 自身的记录已经不允许过期能做出的那个迁移，因此自动处理停在这里。不会有任何东西自动重试。',
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
      '已提交但没收到响应，因此无法确认 Runner 是否接受。这不是失败：系统仍会自动重放这次提交来确认，其余什么都不做。',
    state_execution_disconnected_label: '失联',
    state_execution_disconnected_desc:
      '自动重放已用尽次数，仍未得到 Runner 的确定答复。系统已经停手，不再自动重试；这不等于失败，需要人工确认 Runner 那边到底有没有这个任务。',
    state_execution_succeeded_label: '执行成功',
    state_execution_succeeded_desc: '轮询观察到执行成功，结果可以发布。',
    state_execution_skipped_label: '已跳过',
    state_execution_skipped_desc:
      '因为准备失败，执行从未运行，因此没有可执行的内容。原因记录在准备阶段；这一轴到此结束，不再等待任何东西。',
    state_execution_failed_label: '失败',
    state_execution_failed_desc:
      '确定性的失败，分两种情况：1. 轮询得到了“不可能成功”的确定结论：Runner 报告执行失败，或查不到该 run、没有返回结果、响应不符合约定；2. 重放提交得到确定性失败。而网络抖动（超时、5xx、连接中断）不算确定性失败。',
    state_publication_pending_label: '等待中',
    state_publication_pending_desc: '等待执行成功后开始发布。',
    state_publication_publishing_label: '发布中',
    state_publication_publishing_desc:
      '正在把结果发布出去（创建 PR、评论等）。',
    state_publication_published_label: '已发布',
    state_publication_uncertain_label: '待确认',
    state_publication_uncertain_desc:
      '至少有一个步骤可能已经在远端完成了副作用，正在对账。发布的其他部分不受影响；这不是失败。',
    state_publication_disconnected_label: '失联',
    state_publication_disconnected_desc:
      '某个步骤的自动对账没有得出结论就停手了。必须先由 operator 确认远端到底是什么状态，这个 run 才能收尾。',
    state_publication_published_desc: '全部发布成功，结果已可见。',
    state_publication_failed_label: '失败',
    state_publication_failed_desc:
      '发布已确定失败：可重试的失败会退回「等待中」重试，只有确定性失败或操作员的决定才停在这里。',
    state_publication_skipped_label: '已跳过',
    state_publication_skipped_desc: '因为执行未成功，没有可发布的内容。',
    machine_preparation_title: '准备',
    machine_execution_title: '执行',
    machine_publication_title: '发布',
    edge_preparation_pending_preparing: '有执行者接手，开始准备输入',
    edge_preparation_preparing_submitted: '输入构造完成，已交给 Runner',
    edge_preparation_preparing_pending: '本次准备失败，稍后重试',
    edge_preparation_preparing_uncertain: '认领在准备者回报之前就过期了',
    edge_preparation_uncertain_preparing:
      '有准备者重新认领，先确认上次到底做到了哪一步',
    edge_preparation_preparing_disconnected:
      'run 自身的记录不允许自动收尾，因此停手',
    edge_preparation_disconnected_uncertain: 'operator 把它交回自动恢复',
    // 该轴的三条 operator 决策共用同一个 from->to 键，契约用 reason 区分；这里只描述三者
    // 的共性——由人替自动化收尾，且不声称什么都没发生。具体决策在通知与时间线上。
    edge_preparation_disconnected_failed:
      'operator 没有继续等待，而是替自动化收尾了这个 run',

    edge_publication_publishing_uncertain: '某步骤可能已经在远端生效',
    edge_publication_uncertain_publishing: '该步骤已结算，发布继续进行',
    edge_publication_uncertain_disconnected: '对账无法得出结论',
    edge_publication_disconnected_uncertain:
      'operator 把它交回对账，并获得新的对账预算',
    edge_publication_disconnected_failed:
      'operator 决定停止发布（部分步骤可能已经完成）',
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
      '取得恢复认领，开始重放（状态本身不变，仅记录时间线）',
    edge_execution_uncertain_queued: '重放的提交被接受，任务进入队列',
    edge_execution_uncertain_failed: '重放提交得到确定性失败，判定为失败',
    edge_execution_uncertain_disconnected:
      '重放次数用尽仍未得到答复，停止自动处理',
    edge_execution_disconnected_uncertain:
      'operator 把它交回自动重放，并获得新的预算',
    edge_execution_disconnected_failed:
      'operator 决定不再等待结果（任务可能仍在执行）',
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
      '发布认领过期，被新的发布者接管（状态本身不变，仅记录时间线）',
    edge_publication_publishing_published: '所有发布步骤均成功',
    stateMachinesTitle: '状态机',
    failureNoticeDelivered: '已通知发起人这次运行失败',
    viewFailureNotice: '查看失败通知',
    viewAttentionNotice: '查看待确认通知',
    failureNoticeNotDelivered: '未能通知发起人：通知没能送达 GitHub',
    failureNoticeDelivering: '正在通知发起人这次运行失败',
    attentionNoticeDelivered: '已通知发起人：此次结果仍待确认',
    attentionNoticeNotDelivered: '未能通知发起人：此次结果仍待确认',
    attentionNoticeDelivering: '正在通知发起人：此次结果仍待确认'
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
