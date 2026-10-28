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
    memory: 'Memory',
    viewerNav: 'Viewer',
    viewer: 'Transcript Viewer',
    files: 'Files',
    newFile: 'New file',
    renameFile: 'Rename file',
    deleteFile: 'Delete file',
    deleteFileWarning: 'Delete {file}? This local experiment cannot undo it.',
    filePath: 'File path',
    workspaceEditor: 'Workspace editor',
    workspaceSource: 'File source',
    workspaceInvalidFilename: 'Enter a unique, non-empty file path.',
    jsonInvalid: 'This file is not valid JSON.',
    jsonlRecord: 'Record {record} · line {line}',
    jsonlInvalidRecord: 'Invalid JSON',
    previewUnavailable: 'Preview unavailable',
    contentUnavailable: 'Content unavailable',
    previewUnavailableDescription:
      'This {size} file is binary or exceeds the online preview limit. Download the original bundle to inspect it.',
    runFiles: 'Run files',
    runFilesLoadFailed: 'The run files could not be opened.',
    viewRunFiles: 'View files',
    downloadDiagnosticBundle: 'Download diagnostic bundle',
    confirm: 'Confirm',
    delete: 'Delete',
    viewerPlaceholder: 'Paste transcript JSONL or JSON messages',
    viewerParseFailed: 'The input is not a supported transcript.',
    uploadFile: 'Upload file',
    render: 'Render',
    revision: 'Revision',
    predecessorRevision: 'Predecessor',
    current: 'Current',
    reason: 'Reason',
    maintenanceEnabled: 'Automatic maintenance',
    maintenancePaused: 'Automatic maintenance',
    maintenanceLoading: 'Loading',
    pauseMaintenance: 'Pause automatic maintenance',
    resumeMaintenance: 'Resume automatic maintenance',
    maintenanceControlHelp:
      'Pausing does not stop a maintenance run that is already in progress. If it reaches the save step while paused, that run fails and will not continue when maintenance resumes; the next maintenance run picks the remaining observations up again.',
    maintenanceControlHelpLabel: 'Explain automatic maintenance control',
    editMemoryTree: 'Edit current memory',
    memoryOverview: 'Overview',
    memoryRevisions: 'Revisions',
    revisionGraph: 'Graph',
    revisionList: 'List',
    memoryObservations: 'Observations',
    noRevisions: 'No revisions yet',
    noObservations: 'No observations yet',
    noWorkflowData: 'No workflow data yet',
    extractedUnits: 'Extracted units',
    completedExtractions: 'Completed extractions',
    unitsWithObservation: 'Produced observations',
    unitsWithoutObservation: 'No observation',
    unitsWithoutObservationHelp:
      'Extraction completed, but the extraction agent determined that no observation should be recorded.',
    observationYield: 'Observation yield',
    observationsUnit: 'observations',
    extractionTrend: 'Extraction coverage',
    range30Days: '30 days',
    range90Days: '90 days',
    rangeAll: 'All',
    observationLifecycle: 'Observation lifecycle',
    pendingObservations: 'Pending',
    consumedObservations: 'Included in memory',
    lifecycleTotal: 'Total',
    workflowBreakdown: 'By workflow',
    revisionMethod: 'Created by',
    actions: 'Actions',
    tree: 'Files',
    memoryFilesRevision: 'Memory files · revision {revision}',
    memoryFilesLoadFailed: 'The memory files could not be opened.',
    compareWithPredecessor: 'Changes',
    diffCompare: 'Compare',
    diffWith: 'with',
    memoryDiffLoadFailed: 'The revision changes could not be opened.',
    memoryDiffEmpty: 'This revision has no file changes.',
    emptyWorkspace: 'an empty workspace',
    diffAdded: 'Added',
    diffModified: 'Modified',
    diffDeleted: 'Deleted',
    diffSideBySide: 'Side by side',
    diffUnified: 'Unified',
    downloadMemoryTree: 'Download memory tree',
    resizeFileTree: 'Resize file tree',
    maintenanceProcess: 'Maintenance process',
    content: 'Content',
    process: 'Process',
    extractionProcess: 'Extraction process',
    downloadTranscript: 'Download transcript',
    downloadOriginal: 'Download original',
    transcriptLoadFailed: 'The process transcript could not be opened.',
    transcriptMessageCount: '{count} messages',
    transcriptSystem: 'System',
    transcriptHuman: 'Human',
    transcriptAssistant: 'Assistant',
    transcriptTool: 'Tool',
    transcriptUnknown: 'Unknown',
    transcriptToolCalls: 'Tool calls',
    transcriptContent: 'Message',
    transcriptReasoning: 'Reasoning',
    transcriptResult: 'Tool result',
    transcriptArtifact: 'Artifact',
    transcriptArguments: 'Arguments',
    transcriptCallArguments: 'Call arguments',
    transcriptJumpResult: 'Jump to result',
    transcriptJumpCall: 'Back to call',
    transcriptBefore: 'Before',
    transcriptAfter: 'After',
    transcriptTokensIn: 'In',
    transcriptTokensOut: 'Out',
    transcriptCacheRead: 'Cache read',
    transcriptCacheCreation: 'Cache write',
    transcriptSearch: 'Search messages, tools, and arguments',
    transcriptMinimap: 'Transcript navigation',
    transcriptMinimapPosition: 'Transcript position',
    transcriptShowing: 'Showing {shown} of {total} messages',
    transcriptUsageProcessed: '{count} processed',
    openFullPage: 'Open in new page',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    preview: 'Preview',
    source: 'Source',
    loading: 'Loading…',
    restore: 'Set current',
    alreadyCurrent: 'Already current',
    restoreRevisionTitle: 'Set revision {revision} as current',
    confirmRestore: 'Set as current',
    restoreRevisionWarning:
      'This immediately changes the active memory to revision {revision}. Future automatic maintenance and operator edits will use it as their predecessor. Newer revisions remain in history.',
    observationOutcome: 'Status',
    sourceRun: 'Source run',
    observation: 'No.',
    observationDetail: 'Observation content',
    incorporatedInto: 'Included in',
    revisionReference: 'revision {revision}',
    sourceOperatorEdit: 'Operator edit',
    editMemoryTreeTitle: 'Edit memory files',
    edit: 'Edit',
    commitRevision: 'Commit revision',
    discardMemoryChangesTitle: 'Discard memory changes?',
    discardMemoryChangesWarning:
      'Your edits have not been committed and will be lost.',
    continueEditing: 'Continue editing',
    discardChanges: 'Discard changes',
    memoryLoadFailed: 'Memory data could not be loaded.',
    memoryControlLoadFailed:
      'Automatic maintenance status could not be loaded.',
    memoryTreeLoadFailed: 'The current memory revision could not be loaded.',
    memoryRevisionsLoadFailed: 'Revision history could not be loaded.',
    memoryObservationsLoadFailed: 'Observation records could not be loaded.',
    memoryOverviewLoadFailed: 'Memory overview could not be loaded.',
    memoryControlConflict:
      'Control changed elsewhere. Refresh and confirm again.',
    memoryControlFailed: 'The control change failed.',
    memoryRevisionConflict:
      'The active revision changed. Your text was kept; reload the latest tree before confirming.',
    memoryEditFailed: 'The edit could not be committed.',
    memoryRestoreConflict:
      'The active revision changed. Refresh before changing the current revision.',
    memoryRestoreFailed: 'Could not change the current revision.',
    sourceMaintenance: 'Maintenance',
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
    platform: 'Platform',
    platformGithub: 'GitHub',
    platformGitlab: 'GitLab',
    platformUnknown: 'Unknown',
    integrationInstance: 'Integration instance',
    moreFilters: 'More filters',
    workflowIssueReview: 'Issue review',
    workflowPullRequestReview: 'Pull request review',
    workflowRepositoryReview: 'Repository review',
    all: 'All',
    loadingRuns: 'Loading runs…',
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
    loadingRun: 'Loading run…',
    runProgress: 'Run progress',
    statisticsTitle: 'Model usage',
    statisticsViewDetails: 'View details',
    statisticsDetailsTitle: 'Agent Execution Details',
    statisticsExpandAll: 'Expand all',
    statisticsCollapseAll: 'Collapse all',
    statisticsUpdated: 'Updated',
    statisticsPending: 'Waiting',
    statisticsReconciling: 'Collecting',
    statisticsUnavailable: 'Unavailable',
    statisticsNoObservations:
      'No model usage was collected for this execution.',
    statisticsPartialWarning:
      'This snapshot is incomplete. Some late calls or token usage may be missing.',
    statisticsInputTokens: 'Input',
    statisticsOutputTokens: 'Output',
    statisticsCacheReadTokens: 'Cache read',
    statisticsAgent: 'Agent',
    statisticsModel: 'Model',
    statisticsCalls: 'Calls',
    statisticsCallBreakdown: 'Call',
    statisticsTotal: 'Total',
    statisticsTokens: 'Tokens',
    statisticsTokenUnit: 'tokens',
    statisticsUnknownModel: 'Unknown model',
    statisticsInitialPass: 'Initial review',
    statisticsFeedbackPass: 'Feedback pass',
    statisticsDraftPass: 'Draft',
    statisticsDraftBatch: 'Draft batch',
    statisticsRefinementPass: 'Refinement',
    statisticsUnclassifiedPass: 'Other work',
    statisticsRepositoryScan: 'Repository scan',
    statisticsScanStage: 'Scan stage',
    statisticsDiscovery: 'Discovery',
    statisticsTriage: 'Triage',
    statisticsReviewStage: 'Review stage',
    statisticsDeliveryStage: 'Delivery stage',
    statisticsDeliveryPlanning: 'Delivery planning',
    statisticsPatchSynthesis: 'Patch synthesis',
    statisticsCases: 'cases',
    statisticsUnknownDelivery: 'Unknown delivery',
    statisticsCase: 'Case',
    statisticsDelivery: 'Delivery',
    statisticsCombinedDelivery: 'Combined delivery',
    statisticsCombinedDeliveryCount: 'combined delivery',
    statisticsCombinedDeliveries: 'combined deliveries',
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
      'The Execution Gateway never confirmed whether it accepted the task.',
    failureCodeSubmissionRecoveryExhausted:
      'Replays of the submission kept ending without an answer from the Execution Gateway, so its acceptance is still unknown.',
    failureCodeSubmissionRecoveryAbandoned:
      'An operator stopped waiting for this outcome. Remote execution may still be continuing.',
    failureCodePreparationGivenUp:
      'An operator stopped waiting for this preparation.',
    failureCodePublicationGivenUp:
      'An operator stopped publishing while a step could not be confirmed; that step may already have taken effect on GitHub.',
    failureCodeExecutionFailed:
      'The Execution Gateway reported that the task failed.',
    failureCodeExecutionResultMissing:
      'The Execution Gateway reported success without a usable result.',
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
      'Automatic replays of this task ran out without a conclusive answer from the Execution Gateway, so the system stopped and will not try again on its own. It is not known whether the Execution Gateway accepted this task. Resuming grants a fresh replay budget; abandoning ends the run.',
    disconnectedExecutionOutcomeResume:
      'Resume grants a fresh replay budget so the system can try to establish the outcome again. There is no way to abandon a run in this state yet.',
    disconnectedPublicationTitle: 'This run needs your review',
    disconnectedPublicationBody:
      'Publishing stopped on a step whose result could not be confirmed. Some of this run may already exist on GitHub, and nothing automatic will establish which, so the decision is yours.',
    disconnectedPublicationOutcomeResume:
      'Resume returns the publication to the normal queue with fresh attempt budgets. A publisher will claim it and issue the parked steps again.',
    disconnectedPublicationOutcomeGiveUp:
      'Giving up stops publishing: the run is concluded as failed, and whatever already exists on GitHub stays there.',
    giveUpRun: 'Give up',
    giveUpTitle: 'Stop waiting for this outcome',
    giveUpExplainer:
      'This stops waiting, without claiming that nothing happened. Remote execution may still be continuing, or some publishing steps may already exist on GitHub. This run will not wait for the result any longer and will not publish anything more. Whatever already happened remotely stays there. This cannot be undone.',
    giveUpConfirm: 'Stop waiting',
    disconnectedExecutionOutcomeGiveUp:
      'Giving up stops waiting for the result: the task is recorded as failed with a reason naming this decision, and nothing is published. Remote execution may still be continuing.',
    resumeRun: 'Resume',
    resumeTitle: 'Resume this run',
    resumeExplainer:
      'This hands the run back to automatic recovery instead of ending it. A disconnected preparation returns to Uncertain with a fresh attempt budget. A disconnected publication returns to the normal queue with fresh attempt budgets, so its parked steps are issued again. If recovery still cannot reach a conclusion, the run stops here again.',
    resumeConfirm: 'Resume run',
    sessionExpired: 'Your session expired. Sign in again, then retry.',
    parkedRunsTitle: 'These runs need your review',
    parkedRunsSummary: 'Parked runs need a decision before they can continue.',
    parkedRunsView: 'View',
    showDetails: 'Show details',
    hideDetails: 'Hide details',
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
    unable: 'Unable to load this page',
    requestFailed: 'The service could not complete this request.',
    errorTimeout: 'Review Runs did not respond in time.',
    errorUnreachable: 'Review Runs is unreachable.',
    errorUpstream: 'Review Runs returned an error.',
    retry: 'Retry',
    jumpToRun: 'Jump to run',
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
      'Preparing the input that will be submitted for execution.',
    state_preparation_uncertain_label: 'Uncertain',
    state_preparation_uncertain_desc:
      'The preparer\u2019s claim lapsed before it reported, so it is unknown whether the prepared input reached Review Runs. This is not a failure: the input can be rebuilt and resubmitted under the same identity.',
    state_preparation_disconnected_label: 'Disconnected',
    state_preparation_disconnected_desc:
      'Automatic work stopped because this run\u2019s own records no longer admit the transition expiry could make. Nothing retries it on its own.',
    state_preparation_submitted_label: 'Submitted',
    state_preparation_submitted_desc:
      'The input is ready and has been submitted for execution. Preparation is done.',
    state_preparation_failed_label: 'Failed',
    state_preparation_failed_desc:
      'Preparation failed for good (retries used up, or the input could not be built). The task was never submitted, so execution is skipped.',
    state_execution_pending_label: 'Pending',
    state_execution_pending_desc:
      'The run was created and is still being prepared; nothing has been submitted for execution yet.',
    state_execution_queued_label: 'Queued',
    state_execution_queued_desc:
      'The Execution Gateway accepted the task and will start it; it has not started executing yet.',
    state_execution_running_label: 'Running',
    state_execution_running_desc:
      'Polling observed that the execution service is running this task. A transient network blip while polling does not change this state: the run keeps the last observed value and is polled again, so this state may be a little out of date.',
    state_execution_uncertain_label: 'Uncertain',
    state_execution_uncertain_desc:
      'A submission may have reached the Execution Gateway but its result could not be confirmed. A recovery replays the same run_id to find out whether it ran.',
    state_execution_disconnected_label: 'Disconnected',
    state_execution_disconnected_desc:
      'Automatic replays ran out without a conclusive Execution Gateway answer. Automation has stopped and will not retry by itself; this is not a failure, and an operator has to establish whether the Execution Gateway actually has this task.',
    state_execution_succeeded_label: 'Succeeded',
    state_execution_succeeded_desc:
      'Execution finished successfully; the result can now be published.',
    state_execution_skipped_label: 'Skipped',
    state_execution_skipped_desc:
      'Execution never ran because preparation failed, so there is nothing to execute. The reason lives on the preparation axis; this axis is concluded, not waiting.',
    state_execution_failed_label: 'Failed',
    state_execution_failed_desc:
      'A definite failure, in one of two ways: 1. polling got a conclusive answer that the task cannot succeed — the Execution Gateway reported a failure, or the run could not be found, returned no result, or broke the protocol; 2. a retried submission failed conclusively. A transient network error (a timeout, a 5xx, a dropped connection) is not a definite failure.',
    state_publication_pending_label: 'Pending',
    state_publication_pending_desc:
      'Waiting for a successful result before publishing.',
    state_publication_publishing_label: 'Publishing',
    state_publication_publishing_desc:
      'A publisher owns this run and may issue remote writes, such as creating a pull request or comment.',
    state_publication_published_label: 'Published',
    state_publication_uncertain_label: 'Uncertain',
    state_publication_uncertain_desc:
      'A remote write may have succeeded without its result being recorded. For that step, the system only checks what exists remotely and does not issue the write again.',
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
      'the input is ready and has been submitted for execution',
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
      'the prepared input was submitted and accepted for execution',
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
    edge_execution_queued_running: 'polling saw execution start the task',
    edge_execution_running_succeeded:
      'polling saw execution finish successfully',
    edge_execution_queued_succeeded:
      'polling saw execution finish before it was ever seen running',
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
    edge_publication_disconnected_pending:
      'an operator returned it to the normal publication queue',
    edge_publication_disconnected_failed:
      'an operator stopped publishing (some steps may already exist)',
    stateMachinesTitle: 'State machines',
    stateMachineHint:
      'Tap a connection to read its transition. The list below is the complete reference.',
    stateMachineTransitions: 'Transitions',
    stateMachineNoTransitions: 'No state transitions yet.',
    stateMachineLegendForward: 'Forward',
    stateMachineLegendRevert: 'Retry / back',
    stateMachineLegendCurrent: 'Current',
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
    runs: '运行',
    memory: '记忆',
    viewerNav: '查看器',
    viewer: '过程记录查看器',
    files: '文件',
    newFile: '新建文件',
    renameFile: '重命名文件',
    deleteFile: '删除文件',
    deleteFileWarning: '删除 {file}？这个本地实验无法撤销此操作。',
    filePath: '文件路径',
    workspaceEditor: '工作区编辑器',
    workspaceSource: '文件源码',
    workspaceInvalidFilename: '请输入非空且不重复的文件路径。',
    jsonInvalid: '该文件不是有效的 JSON。',
    jsonlRecord: '记录 {record} · 第 {line} 行',
    jsonlInvalidRecord: 'JSON 无效',
    previewUnavailable: '无法在线预览',
    contentUnavailable: '内容不可用',
    previewUnavailableDescription:
      '该文件大小为 {size}，属于二进制文件或超过在线预览限制。请下载原始包后查看。',
    runFiles: '运行文件',
    runFilesLoadFailed: '无法打开运行文件。',
    viewRunFiles: '查看文件',
    downloadDiagnosticBundle: '下载诊断包',
    confirm: '确定',
    delete: '删除',
    viewerPlaceholder: '粘贴过程记录 JSONL 或 JSON 消息',
    viewerParseFailed: '输入内容不是受支持的过程记录。',
    uploadFile: '上传文件',
    render: '渲染',
    revision: '修订版本',
    predecessorRevision: '前驱',
    current: '当前',
    reason: '原因',
    maintenanceEnabled: '自动维护',
    maintenancePaused: '自动维护',
    maintenanceLoading: '加载中',
    pauseMaintenance: '暂停自动维护',
    resumeMaintenance: '恢复自动维护',
    maintenanceControlHelp:
      '暂停不会中止已经开始的那一轮维护。如果它在暂停期间走到保存步骤，这一轮会失败，恢复后也不会自动继续；之后的维护会重新处理这些内容。',
    maintenanceControlHelpLabel: '说明自动维护控制行为',
    editMemoryTree: '编辑当前记忆',
    memoryOverview: '概览',
    memoryRevisions: '修订历史',
    revisionGraph: '关系图',
    revisionList: '列表',
    memoryObservations: '观察项',
    noRevisions: '暂无修订版本',
    noObservations: '暂无观察项',
    noWorkflowData: '暂无工作流数据',
    extractedUnits: '已完成提取的单元',
    completedExtractions: '完成提取次数',
    unitsWithObservation: '产出观察项',
    unitsWithoutObservation: '未产出观察项',
    unitsWithoutObservationHelp:
      '提取已经完成，但提取 Agent 判定该单元没有需要记录的观察项。',
    observationYield: '观察项产出率',
    observationsUnit: '个观察项',
    extractionTrend: '提取与产出趋势',
    range30Days: '30 天',
    range90Days: '90 天',
    rangeAll: '全部',
    observationLifecycle: '观察项流转',
    pendingObservations: '等待维护',
    consumedObservations: '已纳入记忆',
    lifecycleTotal: '合计',
    workflowBreakdown: '按工作流',
    revisionMethod: '创建方式',
    actions: '操作',
    tree: '文件',
    memoryFilesRevision: '记忆文件 · 修订版本 {revision}',
    memoryFilesLoadFailed: '无法打开记忆文件。',
    compareWithPredecessor: '变更',
    diffCompare: '比较',
    diffWith: '与',
    memoryDiffLoadFailed: '无法打开修订变更。',
    memoryDiffEmpty: '此修订版本没有文件变更。',
    emptyWorkspace: '空工作区',
    diffAdded: '新增',
    diffModified: '修改',
    diffDeleted: '删除',
    diffSideBySide: '并排',
    diffUnified: '统一',
    downloadMemoryTree: '下载记忆树',
    resizeFileTree: '调整文件树宽度',
    maintenanceProcess: '维护过程',
    content: '内容',
    process: '过程',
    extractionProcess: '提取过程',
    downloadTranscript: '下载过程记录',
    downloadOriginal: '下载原始文件',
    transcriptLoadFailed: '无法打开过程记录。',
    transcriptMessageCount: '共 {count} 条消息',
    transcriptSystem: '系统',
    transcriptHuman: '用户',
    transcriptAssistant: 'Agent',
    transcriptTool: '工具',
    transcriptUnknown: '未知',
    transcriptToolCalls: '工具调用',
    transcriptContent: '消息内容',
    transcriptReasoning: '推理过程',
    transcriptResult: '工具结果',
    transcriptArtifact: '附加产物',
    transcriptArguments: '参数',
    transcriptCallArguments: '调用参数',
    transcriptJumpResult: '跳到结果',
    transcriptJumpCall: '返回调用',
    transcriptBefore: '修改前',
    transcriptAfter: '修改后',
    transcriptTokensIn: '输入',
    transcriptTokensOut: '输出',
    transcriptCacheRead: '缓存读取',
    transcriptCacheCreation: '缓存写入',
    transcriptSearch: '搜索消息、工具和参数',
    transcriptMinimap: '过程记录导航',
    transcriptMinimapPosition: '过程记录位置',
    transcriptShowing: '显示 {shown} / {total} 条消息',
    transcriptUsageProcessed: '累计处理 {count}',
    openFullPage: '在新页面打开',
    expandAll: '全部展开',
    collapseAll: '全部收起',
    preview: '预览',
    source: '源码',
    loading: '加载中…',
    restore: '设为当前',
    alreadyCurrent: '已为当前',
    restoreRevisionTitle: '将修订版本 {revision} 设为当前',
    confirmRestore: '设为当前',
    restoreRevisionWarning:
      '这会立即将当前记忆切换为修订版本 {revision}。后续自动维护和人工编辑会以它作为前驱；更新的修订版本仍会保留在历史中。',
    observationOutcome: '状态',
    sourceRun: '来源运行',
    observation: '序号',
    observationDetail: '观察项内容',
    incorporatedInto: '已纳入',
    revisionReference: '修订版本 {revision}',
    sourceOperatorEdit: '人工编辑',
    editMemoryTreeTitle: '编辑记忆文件',
    edit: '编辑',
    commitRevision: '提交修订',
    discardMemoryChangesTitle: '放弃记忆修改？',
    discardMemoryChangesWarning: '这些修改尚未提交，放弃后将无法恢复。',
    continueEditing: '继续编辑',
    discardChanges: '放弃修改',
    memoryLoadFailed: '无法加载记忆数据。',
    memoryControlLoadFailed: '无法加载自动维护状态。',
    memoryTreeLoadFailed: '无法加载当前记忆修订版本。',
    memoryRevisionsLoadFailed: '无法加载修订历史。',
    memoryObservationsLoadFailed: '无法加载观察项。',
    memoryOverviewLoadFailed: '无法加载记忆概览。',
    memoryControlConflict: '维护控制状态已被其他操作修改，请刷新后重新确认。',
    memoryControlFailed: '维护控制操作失败。',
    memoryRevisionConflict:
      '当前修订版本已发生变化。编辑内容仍被保留，请加载最新记忆树后重新确认。',
    memoryEditFailed: '无法提交此次编辑。',
    memoryRestoreConflict: '当前修订版本已发生变化，请刷新后再切换。',
    memoryRestoreFailed: '无法切换当前修订版本。',
    sourceMaintenance: '自动维护',
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
    copyRunId: '复制运行 ID',
    runIdCopied: '已复制运行 ID',
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
    platform: '平台',
    platformGithub: 'GitHub',
    platformGitlab: 'GitLab',
    platformUnknown: '未知',
    integrationInstance: '集成实例',
    moreFilters: '更多筛选',
    workflowIssueReview: 'Issue 审查',
    workflowPullRequestReview: 'PR 审查',
    workflowRepositoryReview: '仓库审查',
    all: '全部',
    loadingRuns: '正在加载运行…',
    emptyRuns: '没有符合筛选条件的结果',
    run: '运行',
    lastActivity: '最后活动',
    timeRange: '时间范围',
    lastHour: '最近 1 小时',
    lastDay: '最近 24 小时',
    lastWeek: '最近 7 天',
    perPage: '每页',
    previousPage: '上一页',
    nextPage: '下一页',
    back: '返回运行列表',
    loadingRun: '正在加载运行…',
    runProgress: '运行进度',
    statisticsTitle: '模型用量',
    statisticsViewDetails: '查看明细',
    statisticsDetailsTitle: 'Agent 执行明细',
    statisticsExpandAll: '全部展开',
    statisticsCollapseAll: '全部折叠',
    statisticsUpdated: '更新时间',
    statisticsPending: '等待统计',
    statisticsReconciling: '正在汇总',
    statisticsUnavailable: '无法获取',
    statisticsNoObservations: '本次执行未采集到模型用量。',
    statisticsPartialWarning:
      '这份快照不完整，可能缺少迟到的调用或部分 token 用量。',
    statisticsInputTokens: '输入',
    statisticsOutputTokens: '输出',
    statisticsCacheReadTokens: '缓存读取',
    statisticsAgent: 'Agent',
    statisticsModel: '模型',
    statisticsCalls: '调用数',
    statisticsCallBreakdown: '调用',
    statisticsTotal: '总计',
    statisticsTokens: 'Token',
    statisticsTokenUnit: 'tokens',
    statisticsUnknownModel: '未知模型',
    statisticsInitialPass: '首次审查',
    statisticsFeedbackPass: '反馈修正 · 第',
    statisticsDraftPass: '初稿',
    statisticsDraftBatch: '初稿批次',
    statisticsRefinementPass: '全局修正',
    statisticsUnclassifiedPass: '其他工作',
    statisticsRepositoryScan: '仓库扫描',
    statisticsScanStage: '扫描阶段',
    statisticsDiscovery: '候选发现',
    statisticsTriage: '归并筛选',
    statisticsReviewStage: '审查阶段',
    statisticsDeliveryStage: '交付阶段',
    statisticsDeliveryPlanning: '交付规划',
    statisticsPatchSynthesis: '补丁生成',
    statisticsCases: '个 Case',
    statisticsUnknownDelivery: '未知交付项',
    statisticsCase: 'Case',
    statisticsDelivery: '交付',
    statisticsCombinedDelivery: '组合交付',
    statisticsCombinedDeliveryCount: '个组合交付',
    statisticsCombinedDeliveries: '个组合交付',
    runHistory: '历史',
    runHistoryEmpty: '暂无记录的变更',
    failureCodePreparationRetryExhausted: '准备阶段反复失败，重试次数已用完。',
    // 每条只说这个码本身的意思：它命名的事实，以及这件事的后果。系统怎么处理、operator 能怎么选，
    // 属于状态和它周围的横幅；在这里重复会把同一件事说两遍，也会把“决定”塞进一个本该只命名事实的词表里。
    failureCodePreparationAbandoned:
      '有人主动结束了这个运行，没有让它继续下去，因此准备阶段按失败收尾。',
    failureCodeExecutionAlreadyAdvanced:
      '准备阶段的认领过期时，执行已经不在「等待中」。准备失败意味着任务从未开始，而这个运行与这一点相矛盾，因此这次过期无法收尾。',
    failureCodeSubmissionUncertain: '执行网关没有确认是否接单。',
    failureCodeSubmissionRecoveryExhausted:
      '提交的重放一直没有得到执行网关的答复，因此它是否被接受仍然未知。',
    failureCodeSubmissionRecoveryAbandoned:
      'operator 决定不再等待这个结果。远端执行可能仍在继续。',
    failureCodePreparationGivenUp: 'operator 决定不再等待这次准备。',
    failureCodePublicationGivenUp:
      '某个步骤无法确认时，operator 决定停止发布；该步骤可能已经在 GitHub 上生效。',
    failureCodeExecutionFailed: '执行网关报告任务执行失败。',
    failureCodeExecutionResultMissing: '执行网关报告成功，但没有可用的结果。',
    failureCodePublicationAbandoned: '这个运行不会产出结果，发布已停止。',
    failureCodePublicationStepRetryExhausted:
      '某个发布步骤反复失败，重试次数已用完。',
    failureCodeGithubValidationRejected: 'GitHub 拒绝了这次尝试发布的内容。',
    cancel: '取消',
    blockedRunTitle: '这个运行需要你审计',
    blockedRunBody:
      '系统停在这里，需要你来决定。它没法继续，因为它要下的结论和这个运行已经记录的东西相矛盾。具体是什么，见下方的代码。',
    blockedNoResumeReason:
      '不提供「恢复」：执行已经走过准备阶段能再次接手的那一点，所以恢复出来的准备永远轮不到接手。',
    blockedOutcomeResume:
      '「恢复」是再试一次：准备阶段回到「待确认」并获得新的尝试预算，已记录的结果不会丢失。',
    blockedOutcomeAbandon:
      '「放弃」是不再尝试：准备记为失败，结果不再发布，已记录的结果作为证据保留。',
    blockedOutcomeAbandonStopsExecution: '该任务仍在执行中，会一并停止。',
    abandonRun: '放弃',
    abandonTitle: '放弃这个运行',
    abandonExplainer: '这会结束这个运行，而不是继续重试，操作不可撤销。',
    abandonExplainerKeepsResult: '它已经记录的结果会作为证据保留。',
    abandonReasonLabel: '为什么放弃它？',
    abandonReasonHint: '会随本次决定一起记录，方便后来的人了解原因。',
    abandonTokenLabel: 'Admin token',
    abandonTokenHint: '只随本次请求发送，不会被保存。',
    abandonConfirm: '放弃',
    abandonWrongToken: 'Admin token 被拒绝。',
    abandonFailed: '放弃失败。',
    disconnectedExecutionTitle: '这个运行无法自行继续',
    disconnectedExecutionBody:
      '这个任务的自动重放已用尽次数，仍未得到执行网关的确定答复，因此系统停手，不再自动重试。执行网关到底有没有接受这个任务，目前不得而知。恢复会给予新的重放预算；放弃则会结束这个运行。',
    disconnectedExecutionOutcomeResume:
      '「恢复」会给予新的重放预算，让系统再尝试确认结果。目前这个状态还没有「放弃」的选项。',
    disconnectedPublicationTitle: '这个运行需要你审计',
    disconnectedPublicationBody:
      '某个步骤的结果无法确认，发布停在了那里。这个运行的部分内容可能已经出现在 GitHub 上，而不会有任何自动处理去查明到底是哪些，因此需要你来决定。',
    disconnectedPublicationOutcomeResume:
      '「恢复」会把发布放回正常队列并刷新尝试预算。发布器取得认领后，会再次执行停住的步骤。',
    disconnectedPublicationOutcomeGiveUp:
      '「放弃」是不再发布：这个运行以失败收尾，已经存在于 GitHub 上的内容保持原样。',
    giveUpRun: '放弃',
    giveUpTitle: '不再等待这个结果',
    giveUpExplainer:
      '这表示不再等待，但并不宣称什么都没发生。远端执行可能仍在继续，也可能已经有部分发布步骤出现在 GitHub 上。这个运行不再等待结果，也不会再发布任何内容；远端已经发生的事会留在那里。此操作不可撤销。',
    giveUpConfirm: '不再等待',
    disconnectedExecutionOutcomeGiveUp:
      '「放弃」是不再等待结果：该任务会记为失败，并注明这是本次决定所致，不发布任何内容。远端执行可能仍在继续。',
    resumeRun: '恢复',
    resumeTitle: '恢复这个运行',
    resumeExplainer:
      '这会把运行交回自动流程，而不是结束它。失联的准备阶段会回到「待确认」并获得新的尝试预算。失联的发布会回到正常队列并刷新尝试预算，停住的步骤会再次执行。如果自动恢复仍无法得出结论，运行会再次停在这里。',
    resumeConfirm: '恢复',
    sessionExpired: '会话已过期。请重新登录后再试。',
    parkedRunsTitle: '这些运行需要你审计',
    parkedRunsSummary: '已暂停的运行需要先做决定才能继续。',
    parkedRunsView: '查看',
    showDetails: '显示详情',
    hideDetails: '隐藏详情',
    parkedRunsBody:
      '这些运行的自动处理都已停下，不会自行继续。每条旁边标明了停下的是哪一轴，因为服务端接受的决定取决于这一轴：停在准备轴的运行只有在执行尚未开始时才能恢复，停在执行轴或发布轴的运行可以恢复，也可以放弃。打开某个运行可以看到服务端接受的决定。',
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
    unable: '无法加载此页面',
    requestFailed: '服务无法完成此请求。',
    errorTimeout: '审查运行服务未在规定时间内响应。',
    errorUnreachable: '无法连接到审查运行服务。',
    errorUpstream: '审查运行服务返回了错误。',
    retry: '重试',
    jumpToRun: '跳转',
    goToRunId: '按 ID 跳转运行',
    runIdPlaceholder: '粘贴运行 ID',
    goToRun: '打开运行',
    runNotFound: '找不到该运行',
    runNotFoundHint: '此处没有存储这个 ID 的运行。',
    state_preparation_pending_label: '等待中',
    state_preparation_pending_desc:
      '任务已创建，但还没有执行者接手：在有人接手之前，这个运行不会有任何进展。',
    state_preparation_preparing_label: '准备中',
    state_preparation_preparing_desc: '正在准备要提交执行的输入。',
    state_preparation_uncertain_label: '待确认',
    state_preparation_uncertain_desc:
      '准备者的认领在回报之前就过期了，因此不确定准备好的输入是否已经到达审查运行服务。这不是失败：可以用同一身份重建输入并重新提交。',
    state_preparation_disconnected_label: '失联',
    state_preparation_disconnected_desc:
      '这个运行自身的记录已经不允许过期能做出的那个迁移，因此自动处理停在这里。不会有任何东西自动重试。',
    state_preparation_submitted_label: '已提交',
    state_preparation_submitted_desc: '输入已准备好并提交执行，准备阶段完成。',
    state_preparation_failed_label: '失败',
    state_preparation_failed_desc:
      '准备最终失败（重试次数用尽，或无法构造输入）。任务从未提交，因此执行被跳过。',
    state_execution_pending_label: '等待中',
    state_execution_pending_desc: '任务已创建，仍在准备中，尚未提交执行。',
    state_execution_queued_label: '排队中',
    state_execution_queued_desc:
      '执行网关已接受这次提交，但轮询还没观察到它开始执行。',
    state_execution_running_label: '执行中',
    state_execution_running_desc:
      '轮询观察到执行端正在执行该任务。轮询时偶发的网络抖动不会改变这个状态：会保留上次观察到的值并继续轮询，因此这个状态可能略有滞后。',
    state_execution_uncertain_label: '待确认',
    state_execution_uncertain_desc:
      '已提交但没收到响应，因此无法确认执行网关是否接受。这不是失败：系统仍会自动重放这次提交来确认，其余什么都不做。',
    state_execution_disconnected_label: '失联',
    state_execution_disconnected_desc:
      '自动重放已用尽次数，仍未得到执行网关的确定答复。系统已经停手，不再自动重试；这不等于失败，需要人工确认执行网关到底有没有这个任务。',
    state_execution_succeeded_label: '执行成功',
    state_execution_succeeded_desc: '执行已成功，结果可以发布。',
    state_execution_skipped_label: '已跳过',
    state_execution_skipped_desc:
      '因为准备失败，执行从未运行，因此没有可执行的内容。原因记录在准备阶段；这一轴到此结束，不再等待任何东西。',
    state_execution_failed_label: '失败',
    state_execution_failed_desc:
      '确定性的失败，分两种情况：1. 轮询得到了“不可能成功”的确定结论：执行网关报告执行失败，或查不到该运行、没有返回结果、响应不符合约定；2. 重放提交得到确定性失败。而网络抖动（超时、5xx、连接中断）不算确定性失败。',
    state_publication_pending_label: '等待中',
    state_publication_pending_desc: '等待执行成功后开始发布。',
    state_publication_publishing_label: '发布中',
    state_publication_publishing_desc:
      'publisher 正持有这个运行，可以向远端执行写入，例如创建 PR 或评论。',
    state_publication_published_label: '已发布',
    state_publication_uncertain_label: '待确认',
    state_publication_uncertain_desc:
      '某次远端写入可能已经成功，但系统没有记录到结果。故而正在查询远端实际结果（此时不会再次发起相同的写入）。',
    state_publication_disconnected_label: '失联',
    state_publication_disconnected_desc:
      '系统多次尝试确认某个步骤的远端结果，但始终没有得到结论，因此自动处理已经停止。必须先由 operator 决定是否继续，这个运行才能收尾。',
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
    edge_preparation_preparing_submitted: '输入构造完成，已提交执行',
    edge_preparation_preparing_pending: '本次准备失败，稍后重试',
    edge_preparation_preparing_uncertain: '认领在准备者回报之前就过期了',
    edge_preparation_uncertain_preparing:
      '有准备者重新认领，先确认上次到底做到了哪一步',
    edge_preparation_preparing_disconnected:
      '运行自身的记录不允许自动收尾，因此停手',
    edge_preparation_disconnected_uncertain: 'operator 把它交回自动恢复',
    // 该轴的三条 operator 决策共用同一个 from->to 键，契约用 reason 区分；这里只描述三者
    // 的共性——由人替自动化收尾，且不声称什么都没发生。具体决策在通知与时间线上。
    edge_preparation_disconnected_failed:
      'operator 没有继续等待，而是替自动化收尾了这个运行',

    edge_publication_publishing_uncertain: '某步骤可能已经在远端生效',
    edge_publication_uncertain_publishing: '该步骤已结算，发布继续进行',
    edge_publication_uncertain_disconnected: '无法确认远端结果',
    edge_publication_disconnected_pending: 'operator 把它放回正常发布队列',
    edge_publication_disconnected_failed:
      'operator 决定停止发布（部分步骤可能已经完成）',
    edge_preparation_preparing_failed:
      '准备失败（可能是重试次数用尽，也可能是不可重试的错误）',
    edge_execution_pending_queued: '准备好的输入已提交，任务已接受',
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
    edge_execution_queued_running: '轮询观察到执行开始',
    edge_execution_running_succeeded: '轮询观察到执行成功',
    edge_execution_queued_succeeded: '首次轮询时执行已完成，未观察到执行中状态',
    edge_execution_queued_failed:
      '轮询得到确定性失败（报告失败、查不到运行、无结果或响应不合约定）',
    edge_execution_running_failed:
      '轮询得到确定性失败（报告失败、查不到运行、无结果或响应不合约定）',
    edge_publication_pending_publishing: '开始发布结果',
    edge_publication_publishing_publishing:
      '发布认领过期，被新的发布者接管（状态本身不变，仅记录时间线）',
    edge_publication_publishing_published: '所有发布步骤均成功',
    stateMachinesTitle: '状态机',
    stateMachineHint: '点按连线查看转移说明；下方列表是完整参考。',
    stateMachineTransitions: '状态转移',
    stateMachineNoTransitions: '暂无状态转移。',
    stateMachineLegendForward: '前进',
    stateMachineLegendRevert: '重试 / 回退',
    stateMachineLegendCurrent: '当前',
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
  // state, not Review Runs account settings.
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
  return React.useCallback((key) => messages[language][key], [language])
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
