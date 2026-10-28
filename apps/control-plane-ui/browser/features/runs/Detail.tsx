import React from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Timeline,
  Title,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconFiles
} from '@tabler/icons-react'
import {
  abandonBlockedRun,
  api,
  ApiError,
  giveUpDisconnectedRun,
  resumeDisconnectedRun,
  type ArtifactStorage,
  type Run,
  throwIfUnauthorized,
  type RunEvent
} from './api.js'
import { RunStateMachines } from './StateMachine.js'
import { RunFilesViewer } from './RunFilesViewer.js'
import { RunJump } from './RunJump.js'
import { ExecutionStatistics } from './ExecutionStatistics.js'
import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import { CopyAction } from '../../shared/CopyAction.js'
import { LoadingState } from '../../shared/StateMessage.js'
import { useRefresh } from '../../shared/refresh.js'
import { PlatformMark } from './PlatformMark.js'
import {
  ExecutionStatus,
  PreparationStatus,
  PublicationStatus,
  type PublicationStepStatus,
  artifactStatusColor,
  artifactStatusLabel,
  axisLabel,
  executionStatusLabel,
  executionTone,
  preparationStateLabel,
  preparationTone,
  publicationStatusColor,
  publicationStatusLabel,
  publicationTone,
  statusBullet,
  statusToneColor
} from './status.js'
import {
  abbreviateDigest,
  failureCodeLabel,
  failureReason,
  formatBytes,
  formatDuration,
  canResumeRun,
  isDownloadableArtifact,
  isRunTerminal,
  phaseElapsed,
  observationAgeMs,
  isObservationStale,
  safeExternalUrl,
  workflowLabel,
  abandonFailureMessageKey
} from './format.js'
import { ICON_SIZE } from '../../shared/design.js'

interface Step {
  step_key: string
  status: PublicationStepStatus
  failure_count: number
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

function Artifact({
  storage,
  runId
}: {
  // Non-null: the caller only renders this when the run actually reported a storage record.
  storage: NonNullable<ArtifactStorage>
  runId: string
}): React.ReactNode {
  const t = useMessages()
  const [expanded, setExpanded] = React.useState(false)
  const [filesOpen, setFilesOpen] = React.useState(false)
  // The contract makes this a discriminated union: `available` always carries the artifact, and
  // the other statuses never do. Narrowing on the status is what the type system can check, so a
  // missing artifact can no longer be silently rendered as an empty panel.
  if (storage.status !== 'available') {
    if (!storage.message && !storage.error_code) return null
    return (
      <div className="artifact-state">
        {storage.message && <Text size="sm">{storage.message}</Text>}
        {storage.error_code && (
          <Text
            c={storage.status === 'failed' ? 'red' : 'dimmed'}
            size="xs"
            ff="monospace"
          >
            {storage.error_code}
          </Text>
        )}
      </div>
    )
  }
  const artifact = storage.artifact
  const hex = artifact.digest.replace(/^sha256:/, '')
  return (
    <>
      <div className="artifact-panel">
        <div className="artifact-row">
          <Badge variant="light" color={artifactStatusColor(storage.status)}>
            {artifactStatusLabel(storage.status, t)}
          </Badge>
          <div className="artifact-facts">
            <Text c="dimmed" size="sm">
              {formatBytes(artifact.size_bytes)}
            </Text>
            <Text c="dimmed" size="xs" ff="monospace">
              {artifact.media_type}
            </Text>
            <div className="artifact-digest-row">
              <Text c="dimmed" size="xs">
                {t('sha256')}
              </Text>
              <UnstyledButton
                type="button"
                className="artifact-digest-toggle"
                aria-expanded={expanded}
                aria-label={expanded ? t('collapseDigest') : t('expandDigest')}
                onClick={() => setExpanded((value) => !value)}
              >
                <code>{expanded ? hex : abbreviateDigest(hex)}</code>
                {expanded ? (
                  <IconChevronUp size={ICON_SIZE.sm} />
                ) : (
                  <IconChevronDown size={ICON_SIZE.sm} />
                )}
              </UnstyledButton>
              <CopyAction
                value={artifact.digest}
                name={t('copyDigest')}
                copiedName={t('digestCopied')}
              />
            </div>
          </div>
          {isDownloadableArtifact(storage) && (
            <Button
              className="artifact-actions"
              variant="default"
              size="xs"
              leftSection={<IconFiles size={ICON_SIZE.sm} />}
              onClick={() => setFilesOpen(true)}
            >
              {t('viewRunFiles')}
            </Button>
          )}
        </div>
      </div>
      <RunFilesViewer
        runId={filesOpen ? runId : undefined}
        onClose={() => setFilesOpen(false)}
      />
    </>
  )
}

/** The operator decision for one blocked run.
 *
 * The admin token is entered here, held only in this component's state, and sent with the single
 * request. The console backend forwards it and keeps no copy, so closing the dialog (or the tab)
 * leaves nothing behind that could act later. Asking again for every abandonment is deliberate:
 * the action concludes a run and cannot be undone.
 */
function AbandonDialog({
  runId,
  keepsResult,
  opened,
  onClose,
  onDone
}: {
  runId: string
  /** Whether the run has a result at all. A run whose execution never produced one has nothing
   * to keep, so promising it would be kept would describe something that does not exist. */
  keepsResult: boolean
  opened: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const t = useMessages()
  const [reason, setReason] = React.useState('')
  const [adminToken, setAdminToken] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  // Reset whenever the dialog opens for a different run, so a token typed for one decision is
  // never silently reused for the next.
  React.useEffect(() => {
    if (!opened) return
    setReason('')
    setAdminToken('')
    setFailure(null)
    setSubmitting(false)
  }, [opened, runId])

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setFailure(null)
    try {
      await abandonBlockedRun(runId, reason.trim(), adminToken.trim())
      await onDone()
    } catch (error) {
      setFailure(t(abandonFailureMessageKey(error)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t('abandonTitle')} centered>
      <Stack gap="sm">
        <Text size="sm">
          {t('abandonExplainer')}
          {keepsResult && ` ${t('abandonExplainerKeepsResult')}`}
        </Text>
        <Text size="xs" ff="monospace" c="dimmed">
          {runId}
        </Text>
        <Textarea
          label={t('abandonReasonLabel')}
          description={t('abandonReasonHint')}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          autosize
          minRows={2}
          required
        />
        <TextInput
          label={t('abandonTokenLabel')}
          description={t('abandonTokenHint')}
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.currentTarget.value)}
          required
        />
        {failure !== null && (
          <Text role="alert" c="red" size="sm">
            {failure}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            color="red"
            loading={submitting}
            disabled={reason.trim() === '' || adminToken.trim() === ''}
            onClick={() => {
              void submit()
            }}
          >
            {t('abandonConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** Stop waiting for an outcome that cannot be established.
 *
 * Distinct from `AbandonDialog`, which resolves a *contradiction*. This one accepts that the
 * outcome is unknowable — the Execution API may have accepted the task, a publication step may already
 * have taken effect — and records only that the run will not wait for it any longer. A reason is
 * required because the decision is irreversible and says nothing about what actually happened.
 */
function GiveUpDialog({
  runId,
  opened,
  onClose,
  onDone
}: {
  runId: string
  opened: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const t = useMessages()
  const [reason, setReason] = React.useState('')
  const [adminToken, setAdminToken] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!opened) return
    setReason('')
    setAdminToken('')
    setFailure(null)
    setSubmitting(false)
  }, [opened, runId])

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setFailure(null)
    try {
      await giveUpDisconnectedRun(runId, reason.trim(), adminToken.trim())
      await onDone()
    } catch (error) {
      setFailure(t(abandonFailureMessageKey(error)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t('giveUpTitle')} centered>
      <Stack gap="sm">
        <Text size="sm">{t('giveUpExplainer')}</Text>
        <Text size="xs" ff="monospace" c="dimmed">
          {runId}
        </Text>
        <Textarea
          label={t('abandonReasonLabel')}
          description={t('abandonReasonHint')}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          autosize
          minRows={2}
          required
        />
        <TextInput
          label={t('abandonTokenLabel')}
          description={t('abandonTokenHint')}
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.currentTarget.value)}
          required
        />
        {failure !== null && (
          <Text role="alert" c="red" size="sm">
            {failure}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            color="orange"
            loading={submitting}
            disabled={reason.trim() === '' || adminToken.trim() === ''}
            onClick={() => {
              void submit()
            }}
            data-testid="give-up-confirm"
          >
            {t('giveUpConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** The other operator decision for a blocked run: try again.
 *
 * Resuming is a request, not a repair: Review Runs puts the row back in `uncertain` with a
 * fresh attempt budget so automatic recovery can establish what the previous owner left behind.
 * It is offered next to abandonment because those are the only two decisions such a run is
 * waiting for. No reason is asked for: nothing is concluded, and the credential handling is the
 * same one-request rule as abandonment.
 */
function ResumeDialog({
  runId,
  opened,
  onClose,
  onDone
}: {
  runId: string
  opened: boolean
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const t = useMessages()
  const [adminToken, setAdminToken] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!opened) return
    setAdminToken('')
    setFailure(null)
    setSubmitting(false)
  }, [opened, runId])

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setFailure(null)
    try {
      await resumeDisconnectedRun(runId, adminToken.trim())
      await onDone()
    } catch (error) {
      setFailure(t(abandonFailureMessageKey(error)))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t('resumeTitle')} centered>
      <Stack gap="sm">
        <Text size="sm">{t('resumeExplainer')}</Text>
        <Text size="xs" ff="monospace" c="dimmed">
          {runId}
        </Text>
        <TextInput
          label={t('abandonTokenLabel')}
          description={t('abandonTokenHint')}
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.currentTarget.value)}
          required
        />
        {failure !== null && (
          <Text role="alert" c="red" size="sm">
            {failure}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            loading={submitting}
            disabled={adminToken.trim() === ''}
            onClick={() => {
              void submit()
            }}
            data-testid="resume-run-confirm"
          >
            {t('resumeConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

/** What the requester was told about this phase, shown inside that phase.
 *
 * Notices are of two kinds: a `failure` (the run really ended) and an `attention` (automation
 * stopped without a conclusion, so someone has to look). Only a failure may be worded as one;
 * an attention notice says the outcome is unconfirmed. The line belongs to the phase, not to the
 * run's footer: "the user was told" is part of what happened in preparation, execution, or
 * publication, and a separate line at the bottom detached it from the evidence above it. A
 * delivery that could not be completed is reported here too, because its absence is the
 * operator's problem to notice.
 */
function NoticeLine({
  notice
}: {
  notice: Run['notices'][number]
}): React.JSX.Element {
  const t = useMessages()
  // Phrased as "who knows", not as "a notice was delivered/failed": "Failure notice: delivery
  // failed" says the same thing twice and still leaves the reader asking whether anyone was told.
  const label =
    notice.kind === 'attention'
      ? notice.status === 'delivered'
        ? t('attentionNoticeDelivered')
        : notice.status === 'failed'
          ? t('attentionNoticeNotDelivered')
          : t('attentionNoticeDelivering')
      : notice.status === 'delivered'
        ? t('failureNoticeDelivered')
        : notice.status === 'failed'
          ? t('failureNoticeNotDelivered')
          : t('failureNoticeDelivering')
  // Only a delivered notice has a comment to open; a failed or in-flight one has nothing to
  // link to, which is exactly when the reader needs to know the requester was never told.
  const href = notice.comment_url ?? undefined
  return (
    <Text
      className="failure-notice-line"
      size="xs"
      c={notice.status === 'failed' ? 'red' : 'dimmed'}
      data-testid="failure-notice"
    >
      {href === undefined ? (
        label
      ) : (
        <Anchor
          href={href}
          target="_blank"
          rel="noreferrer"
          size="xs"
          data-testid="failure-notice-link"
        >
          {notice.kind === 'attention'
            ? t('viewAttentionNotice')
            : t('viewFailureNotice')}
        </Anchor>
      )}
    </Text>
  )
}

/** A failure code, with its meaning on hover when the console knows one.
 *
 * The code stays visible either way: it is what the logs and the Execution API use, and an operator
 * searching for it must not have to reconstruct it from a tooltip. A code the console does not
 * recognise renders plainly rather than being guessed at.
 */
function ExplainedCode({
  code,
  className,
  tone = 'error',
  size = 'xs'
}: {
  code: string
  className?: string
  /** `error` for a failure code, `neutral` for a state marker that is not itself a failure. */
  tone?: 'error' | 'neutral'
  size?: 'xs' | 'sm'
}): React.JSX.Element {
  const t = useMessages()
  const { explanation } = failureCodeLabel(code, t)
  // Inline on purpose: as a block, a wrapping parent stretches this element to the row height
  // and the code no longer shares a baseline with the label beside it.
  const label = (
    <Text
      component="span"
      className={className}
      c={tone === 'error' ? 'red' : 'dimmed'}
      size={size}
      ff="monospace"
    >
      {code}
    </Text>
  )
  if (explanation === null) return label
  return (
    <Tooltip
      label={explanation}
      multiline
      w={360}
      withArrow
      position="bottom-start"
      // Long enough to wrap to several lines; the default delay would make it feel broken.
      openDelay={150}
    >
      {label}
    </Tooltip>
  )
}

export function Detail(): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const { runId = '' } = useParams()
  const location = useLocation()
  // Restore the list's filters and cursor when the reader came from it. A reload or
  // a deep link has no such state, so fall back to an unfiltered first page.
  const listSearch = (location.state as { listSearch?: string } | null)
    ?.listSearch
  const backTo = listSearch ? `/runs?${listSearch}` : '/runs'
  // Both are keyed by run id. React Router keeps this component mounted when only the
  // id changes, so unkeyed state would keep rendering the previous run — and a 404 for
  // the new id would then be reported as a failed refresh of the old one.
  const [loaded, setLoaded] = React.useState<{
    runId: string
    run: Run
    steps: Step[]
    events: RunEvent[]
  }>()
  const [failure, setFailure] = React.useState<{
    runId: string
    error: unknown
  }>()
  const [abandoning, setAbandoning] = React.useState(false)
  const [resuming, setResuming] = React.useState(false)
  const [givingUp, setGivingUp] = React.useState(false)
  const run = loaded?.runId === runId ? loaded.run : undefined
  const steps = loaded?.runId === runId ? loaded.steps : []
  const events = loaded?.runId === runId ? loaded.events : []
  const error = failure?.runId === runId ? failure.error : undefined
  // What the reason code means, looked up once. The banner names the conflict only through this
  // sentence, so an unrecognised code renders plainly instead of guessing at a cause.
  const disconnectExplanation = run?.preparation.disconnect_reason
    ? failureCodeLabel(run.preparation.disconnect_reason, t).explanation
    : null
  // Abandoning stops an execution that is still moving, and leaves a finished one alone. Saying
  // so unconditionally would describe a stop that cannot happen - a run whose task already
  // completed has nothing left to stop.
  const executionStillMovable =
    run !== undefined &&
    ['queued', 'running', 'uncertain'].includes(run.execution.status)
  // Which axis parked this run, so the banner's wording follows one value instead of a chain of
  // ternaries that silently falls back to the preparation case for anything new. Preparation wins
  // when present because it always explains the others: it parks only by contradicting execution.
  const parkedAxis: 'preparation' | 'execution' | 'publication' | null =
    run === undefined
      ? null
      : run.preparation.status === 'disconnected'
        ? 'preparation'
        : run.execution.status === 'disconnected'
          ? 'execution'
          : run.publication.status === 'disconnected'
            ? 'publication'
            : null
  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [runValue, stepValue, eventValue] = await Promise.all([
        api<{ run: Run }>(`/runs/${encodeURIComponent(runId)}`),
        api<{ publication_steps: Step[] }>(
          `/runs/${encodeURIComponent(runId)}/publication-steps`
        ),
        api<{ events: RunEvent[] }>(`/runs/${encodeURIComponent(runId)}/events`)
      ])
      setLoaded({
        runId,
        run: runValue.run,
        steps: stepValue.publication_steps,
        events: eventValue.events
      })
      setFailure(undefined)
    } catch (value) {
      setFailure({ runId, error: value })
    }
  }, [runId])
  const terminal = run ? isRunTerminal(run) : false
  // Polls while the run is active. The detail page renders no refresh chrome, so
  // the hook's display state (refreshing / lastChecked) is intentionally unused.
  useRefresh(load, !terminal)
  const [, setClockTick] = React.useState(0)
  React.useEffect(() => {
    if (terminal) return
    const timer = window.setInterval(
      () => setClockTick((tick) => tick + 1),
      10_000
    )
    return (): void => window.clearInterval(timer)
  }, [terminal])
  const titleRunId = run?.run_id
  React.useEffect(() => {
    if (titleRunId === undefined) return
    document.title = `${titleRunId} · Control Plane UI`
    return (): void => {
      document.title = 'Control Plane UI'
    }
  }, [titleRunId])
  throwIfUnauthorized(error)
  if (error !== undefined && run === undefined) {
    // A missing run is not a service failure, and the generic error page would
    // misreport it as one — including for a hand-edited or stale link.
    if (error instanceof ApiError && error.status === 404) {
      return (
        <Container size="lg" py="xl">
          <Title order={1} mb="xs">
            {t('runNotFound')}
          </Title>
          <Text c="dimmed" mb="md">
            {t('runNotFoundHint')}
          </Text>
          <Text ff="monospace" mb="lg">
            {runId}
          </Text>
          <Button
            component={Link}
            to={backTo}
            variant="subtle"
            px={0}
            leftSection={<IconArrowLeft size={ICON_SIZE.md} />}
          >
            {t('back')}
          </Button>
        </Container>
      )
    }
    throw error
  }
  const publicationOutcomes = steps.filter(
    (step) =>
      step.status !== 'succeeded' ||
      safeExternalUrl(step.remote_object_url) !== undefined
  )
  const publicationIndex = 3
  const timelineActive =
    run?.publication.status === 'pending'
      ? publicationIndex - 1
      : publicationIndex
  // A publication timestamp only exists once the phase has begun: `publication.started_at`
  // is written on the first claim and `publication.finished_at` when it reaches a terminal
  // state. A run that is still `pending`, or whose publication was ruled out as `skipped`,
  // never started, so it has no such moment to present.
  //
  // This asks the timestamp rather than the status on purpose: a status list has to be
  // updated whenever the contract gains a state, and a forgotten entry would silently hide a
  // real publication. `started_at` is exactly the fact being reported.
  const publishedStart = run?.publication.started_at ?? null
  return (
    <Container size="lg" py="xl">
      <Group justify="space-between" align="center" mb="lg" wrap="wrap">
        <Button
          component={Link}
          to={backTo}
          variant="subtle"
          px={0}
          leftSection={<IconArrowLeft size={ICON_SIZE.md} />}
        >
          {t('back')}
        </Button>
        <RunJump />
      </Group>
      {run === undefined ? (
        <LoadingState message={t('loadingRun')} />
      ) : (
        <>
          <div className="run-heading">
            <Group gap="xs" align="center" wrap="nowrap">
              <Title order={1} className="run-id" ff="monospace">
                {run.run_id}
              </Title>
              <CopyAction
                value={run.run_id}
                name={t('copyRunId')}
                copiedName={t('runIdCopied')}
              />
            </Group>
            <div className="run-summary-grid">
              <div className="run-summary-item">
                <Group gap={6} align="baseline" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {t('workflow')}
                  </Text>
                  <Text size="sm">{workflowLabel(run.workflow, t)}</Text>
                </Group>
              </div>
              <div className="run-summary-item">
                {/* Text-only pairs use baseline alignment, but PlatformMark starts with an
                    inline SVG. Baseline-aligning that flex item uses the SVG box as the
                    reference and visibly lifts both the icon and platform name. */}
                <Group gap={6} align="center" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {t('platform')}
                  </Text>
                  <PlatformMark
                    platform={run.source_platform}
                    githubLabel={t('platformGithub')}
                    gitlabLabel={t('platformGitlab')}
                    unknownLabel={t('platformUnknown')}
                    size="sm"
                  />
                </Group>
              </div>
              <div className="run-summary-item run-summary-integration">
                <Group gap={6} align="baseline" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {t('integrationInstance')}
                  </Text>
                  <Text
                    size="sm"
                    ff="monospace"
                    className="integration-id"
                    title={run.connector_id}
                  >
                    {run.connector_id}
                  </Text>
                </Group>
              </div>
              <div className="run-summary-item">
                <Group gap={6} align="baseline" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {t('preparation')}
                  </Text>
                  <PreparationStatus preparation={run.preparation} />
                </Group>
              </div>
              <div className="run-summary-item">
                <Group gap={6} align="baseline" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {t('execution')}
                  </Text>
                  <ExecutionStatus status={run.execution.status} />
                </Group>
              </div>
              <div className="run-summary-item">
                <Group gap={6} align="baseline" wrap="nowrap">
                  <Text c="dimmed" size="xs">
                    {t('publication')}
                  </Text>
                  <PublicationStatus status={run.publication.status} />
                </Group>
              </div>
              {run.failure_code && (
                <div className="run-summary-failure">
                  {/* `baseline` keeps the label and monospace code visually aligned. */}
                  <Group gap={6} wrap="wrap" align="baseline">
                    <Text c="dimmed" size="xs">
                      {t('failureCode')}:
                    </Text>
                    <ExplainedCode code={run.failure_code} size="xs" />
                  </Group>
                </div>
              )}
            </div>
          </div>
          <Stack gap="xl">
            {Boolean(error) && (
              <Text role="alert" c="red">
                {t('refreshFailed')}
                {failureReason(error, t) && ` ${failureReason(error, t)}`}
              </Text>
            )}
            <AbandonDialog
              runId={run.run_id}
              keepsResult={
                run.execution.status === 'succeeded' ||
                run.execution.status === 'failed'
              }
              opened={abandoning}
              onClose={() => setAbandoning(false)}
              onDone={async () => {
                setAbandoning(false)
                await load()
              }}
            />
            <ResumeDialog
              runId={run.run_id}
              opened={resuming}
              onClose={() => setResuming(false)}
              onDone={async () => {
                setResuming(false)
                await load()
              }}
            />
            <GiveUpDialog
              runId={run.run_id}
              opened={givingUp}
              onClose={() => setGivingUp(false)}
              onDone={async () => {
                setGivingUp(false)
                await load()
              }}
            />
            {/* Every axis that can park must reach this banner, or a parked run shows no
                decision at all - the queue names it and the detail page offers nothing. */}
            {(run.preparation.status === 'disconnected' ||
              run.execution.status === 'disconnected' ||
              run.publication.status === 'disconnected') && (
              <Alert
                // A run the system refused to conclude. `Alert` rather than `Paper`: this is a
                // call to act, and it must not look like another content card on the page.
                color="orange"
                variant="light"
                radius="md"
                p="lg"
                title={
                  <Group gap="xs" align="center" wrap="nowrap">
                    <IconAlertTriangle size={ICON_SIZE.md} aria-hidden />
                    <span>
                      {t(
                        parkedAxis === 'preparation'
                          ? 'blockedRunTitle'
                          : parkedAxis === 'execution'
                            ? 'disconnectedExecutionTitle'
                            : 'disconnectedPublicationTitle'
                      )}
                    </span>
                  </Group>
                }
                className="blocked-run"
                data-testid="blocked-run"
              >
                <Stack gap="sm">
                  {/* The button centres on the explanation alone. The code sits outside this
                      row: it is a reference value, and letting it lengthen the row would drag
                      the button below the middle of the sentence it belongs to. */}
                  <Group
                    justify="space-between"
                    align="center"
                    gap="lg"
                    wrap="nowrap"
                    className="blocked-run-content"
                  >
                    {/* The two parked states have different causes and different
                        consequences, so the explanation follows the axis that stopped rather
                        than describing the preparation contradiction in both cases. */}
                    <Stack gap="xs">
                      <Text size="sm" className="blocked-run-body">
                        {t(
                          parkedAxis === 'preparation'
                            ? 'blockedRunBody'
                            : parkedAxis === 'execution'
                              ? 'disconnectedExecutionBody'
                              : 'disconnectedPublicationBody'
                        )}
                      </Text>
                      {/* What each decision actually does, stated before it is taken rather
                          than discovered afterwards. The two buttons look alike, and only the
                          consequence tells them apart. A resume is only described when the
                          server would accept it: an unusable decision is not offered, and its
                          description is not shown either. */}
                      {canResumeRun(run) && (
                        <Text size="xs" c="dimmed">
                          {t(
                            parkedAxis === 'preparation'
                              ? 'blockedOutcomeResume'
                              : parkedAxis === 'execution'
                                ? 'disconnectedExecutionOutcomeResume'
                                : 'disconnectedPublicationOutcomeResume'
                          )}
                        </Text>
                      )}
                      {!canResumeRun(run) && (
                        <Text size="xs" c="dimmed">
                          {t('blockedNoResumeReason')}
                        </Text>
                      )}
                      <Text size="xs" c="dimmed">
                        {t(
                          parkedAxis === 'preparation'
                            ? 'blockedOutcomeAbandon'
                            : parkedAxis === 'execution'
                              ? 'disconnectedExecutionOutcomeGiveUp'
                              : 'disconnectedPublicationOutcomeGiveUp'
                        )}
                        {/* Only when there is something to stop. */}
                        {parkedAxis === 'preparation' &&
                          executionStillMovable &&
                          ` ${t('blockedOutcomeAbandonStopsExecution')}`}
                      </Text>
                    </Stack>
                    {/* Resuming is offered first: it keeps the run alive, while the other
                        decision stops waiting for it. The labels differ by axis because the
                        decisions do: a contradicted run is abandoned, while an unknowable
                        outcome is given up on, which claims nothing about what happened.
                        The group is non-shrinking as a unit, so no button collapses when the
                        explanation fills the row. */}
                    <Group
                      gap="xs"
                      wrap="nowrap"
                      className="blocked-run-action"
                    >
                      {canResumeRun(run) && (
                        <Button
                          variant="default"
                          size="xs"
                          onClick={() => setResuming(true)}
                          data-testid="resume-run"
                        >
                          {t('resumeRun')}
                        </Button>
                      )}
                      {/* Two different decisions reach the same server operation, and the
                          label follows the axis: a contradicted run is abandoned, while an
                          unknowable outcome is given up on. */}
                      {run.preparation.status === 'disconnected' ? (
                        <Button
                          color="red"
                          variant="filled"
                          size="xs"
                          onClick={() => setAbandoning(true)}
                          data-testid="abandon-run"
                          className="blocked-run-action"
                        >
                          {t('abandonRun')}
                        </Button>
                      ) : (
                        <Button
                          color="red"
                          variant="filled"
                          size="xs"
                          onClick={() => setGivingUp(true)}
                          data-testid="give-up-run"
                          className="blocked-run-action"
                        >
                          {t('giveUpRun')}
                        </Button>
                      )}
                    </Group>
                  </Group>
                  {/* The banner states only that the run stopped and why a decision is needed;
                      this is where the specific conflict is named. It is shown, not hidden
                      behind a tooltip: the banner points the reader here, and a tooltip would
                      make that pointer lead nowhere unless guessed at. A code the console does
                      not know still renders as the bare code. */}
                  {run.preparation.disconnect_reason !== null && (
                    <Stack gap={4}>
                      <Text size="xs" ff="monospace" c="dimmed">
                        {run.preparation.disconnect_reason}
                      </Text>
                      {disconnectExplanation !== null && (
                        <Text size="xs" c="dimmed">
                          {disconnectExplanation}
                        </Text>
                      )}
                    </Stack>
                  )}
                </Stack>
              </Alert>
            )}
            <Paper component="section" withBorder radius="sm" p="md">
              <Title order={2} mb="lg">
                {t('runProgress')}
              </Title>
              <Timeline
                active={timelineActive}
                bulletSize={24}
                lineWidth={2}
                className="run-progress-timeline"
              >
                <Timeline.Item
                  bullet={<IconClock size={ICON_SIZE.sm} />}
                  title={t('created')}
                >
                  <Text c="dimmed" size="sm">
                    {formatDate(run.created_at, language)}
                  </Text>
                </Timeline.Item>
                <Timeline.Item
                  bullet={statusBullet(preparationTone(run.preparation))}
                  color={statusToneColor(preparationTone(run.preparation))}
                  title={<Text fw={500}>{t('preparation')}</Text>}
                >
                  {/* A pending preparation has not begun, so there is no timestamp to show and
                      nothing to time. `started_at` is the phase start and `finished_at` its end;
                      `updated_at` also moves on claim heartbeats and input checkpoints and so
                      cannot time the phase. */}
                  <Text c="dimmed" size="sm">
                    {run.preparation.started_at === null
                      ? preparationStateLabel(run.preparation.status, t)
                      : formatDate(run.preparation.started_at, language)}
                    {run.preparation.started_at !== null && (
                      <>
                        {' · '}
                        {phaseElapsed(
                          run.preparation.started_at,
                          run.preparation.finished_at,
                          t
                        )}
                      </>
                    )}
                    {' · '}
                    {t('preparationAttempts')}: {run.preparation.attempt_count}
                  </Text>
                  {run.notices
                    .filter((notice) => notice.axis === 'preparation')
                    .map((notice) => (
                      <NoticeLine key={notice.notice_id} notice={notice} />
                    ))}
                </Timeline.Item>
                <Timeline.Item
                  bullet={statusBullet(executionTone(run.execution.status))}
                  color={statusToneColor(executionTone(run.execution.status))}
                  title={<Text fw={500}>{t('execution')}</Text>}
                >
                  {run.execution.started_at === null ? (
                    // Execution has not begun: either preparation has not handed the input to the
                    // Execution API yet (nothing to time), or it never will because preparation failed
                    // and the axis was concluded as `skipped`. The latter has an end without a
                    // start, so report when it was concluded rather than a duration it never had.
                    <Text c="dimmed" size="sm">
                      {executionStatusLabel(run.execution.status, t)}
                      {run.execution.finished_at !== null &&
                        ` · ${formatDate(run.execution.finished_at, language)}`}
                    </Text>
                  ) : (
                    <Text c="dimmed" size="sm">
                      {formatDate(run.execution.started_at, language)} ·{' '}
                      {phaseElapsed(
                        run.execution.started_at,
                        // The phase end is its own field, not the observation heartbeat: the two
                        // agree for now because polling stops at a terminal state, but only
                        // `execution_finished_at` promises it. `skipped` has an end without ever
                        // having been submitted, so it takes the other branch above.
                        run.execution.finished_at,
                        t
                      )}
                    </Text>
                  )}
                  {observationAgeMs(run) !== null && (
                    <Text
                      c={isObservationStale(run) ? 'yellow' : 'dimmed'}
                      size="xs"
                      mt={2}
                    >
                      {isObservationStale(run) && '⚠ '}
                      {t('observedAgo')}:{' '}
                      {formatDuration(observationAgeMs(run) ?? 0, t)}
                      {isObservationStale(run) && ` · ${t('observationStale')}`}
                    </Text>
                  )}
                  {run.notices
                    .filter((notice) => notice.axis === 'execution')
                    .map((notice) => (
                      <NoticeLine key={notice.notice_id} notice={notice} />
                    ))}
                  {run.artifact_storage !== null && (
                    <div className="artifact-section">
                      <Artifact
                        storage={run.artifact_storage}
                        runId={run.run_id}
                      />
                    </div>
                  )}
                  {run.execution.started_at !== null && (
                    <ExecutionStatistics
                      statistics={run.execution_statistics}
                      workflow={run.workflow}
                    />
                  )}
                </Timeline.Item>
                <Timeline.Item
                  bullet={statusBullet(publicationTone(run.publication.status))}
                  color={statusToneColor(
                    publicationTone(run.publication.status)
                  )}
                  title={<Text fw={500}>{t('publication')}</Text>}
                >
                  <div className="publication-summary">
                    {publishedStart !== null && (
                      <Text c="dimmed" size="sm">
                        {/* The publication phase starts when the work is first claimed, not
                            when execution ended: the gap between the two is the coordinator's
                            polling wait and is not publishing time. The guard above proves the
                            start exists, and `finished_at` is present exactly for terminal
                            states, so neither is papered over with a fallback. */}
                        {formatDate(
                          run.publication.finished_at ?? publishedStart,
                          language
                        )}{' '}
                        ·{' '}
                        {phaseElapsed(
                          publishedStart,
                          run.publication.finished_at,
                          t
                        )}
                      </Text>
                    )}
                  </div>
                  {publicationOutcomes.length > 0 && (
                    <div className="delivery-list">
                      {publicationOutcomes.map((step) => {
                        const externalUrl = safeExternalUrl(
                          step.remote_object_url
                        )
                        const succeeded = step.status === 'succeeded'
                        const failure = step.failure_code
                          ? failureCodeLabel(step.failure_code, t)
                          : null
                        // Coordination-owned codes have stable localized explanations. Connector
                        // messages remain the fallback because their open-ended codes cannot be
                        // translated without inventing meaning the console does not own.
                        const failureMessage =
                          failure?.explanation ?? step.failure_message
                        return (
                          <div className="delivery-item" key={step.step_key}>
                            {/* Identity on one line: the step's own key belongs beside its
                                status, not stranded on a line of its own. */}
                            <div className="delivery-main">
                              <Badge
                                variant="light"
                                color={publicationStatusColor(step.status)}
                              >
                                {publicationStatusLabel(step.status, t)}
                              </Badge>
                              <code className="delivery-step-key">
                                {step.step_key}
                              </code>
                            </div>
                            {externalUrl && (
                              <Anchor
                                component="a"
                                href={externalUrl}
                                target="_blank"
                                rel="noreferrer"
                                size="sm"
                                className="delivery-link"
                              >
                                {t('openExternalLink')}
                                <IconArrowUpRight
                                  size={14}
                                  aria-hidden="true"
                                />
                              </Anchor>
                            )}
                            {!succeeded &&
                              (step.failure_message ||
                                step.failure_code ||
                                step.failure_count > 0) && (
                                <div className="delivery-error">
                                  {failureMessage && (
                                    <Text size="sm">{failureMessage}</Text>
                                  )}
                                  <Group gap="sm">
                                    {step.failure_code && (
                                      <ExplainedCode
                                        code={step.failure_code}
                                        tone="neutral"
                                      />
                                    )}
                                    {step.failure_count > 0 && (
                                      <Text c="dimmed" size="xs">
                                        {t('failedAttempts')}:{' '}
                                        {step.failure_count}
                                      </Text>
                                    )}
                                  </Group>
                                </div>
                              )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {run.notices
                    .filter((notice) => notice.axis === 'publication')
                    .map((notice) => (
                      <NoticeLine key={notice.notice_id} notice={notice} />
                    ))}
                </Timeline.Item>
              </Timeline>
              <RunStateMachines run={run} events={events} />
              {events.length > 0 && (
                // A native disclosure keeps this operator detail out of the way until asked
                // for, collapses without page state, and stays keyboard/screen-reader
                // accessible. It is a compact list rather than a table: one transition per
                // line reads better than four columns at this density.
                <details className="run-history">
                  <summary className="run-history-summary">
                    <IconChevronRight
                      size={14}
                      className="run-history-chevron"
                      aria-hidden="true"
                    />
                    {t('runHistory')}
                    <span className="run-history-count">{events.length}</span>
                  </summary>
                  <ul className="run-history-list">
                    {events.map((event) => (
                      <li key={event.event_id} className="run-history-item">
                        <span className="run-history-time">
                          {formatDate(event.occurred_at, language)}
                        </span>
                        <span className="run-history-axis">
                          {axisLabel(event.axis, t)}
                        </span>
                        <span className="run-history-transition">
                          {event.from_status === null ? '—' : event.from_status}
                          {' → '}
                          {event.to_status}
                        </span>
                        {event.reason_code !== null && (
                          <ExplainedCode
                            code={event.reason_code}
                            className="run-history-reason"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </Paper>
          </Stack>
        </>
      )}
    </Container>
  )
}
