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
  Tooltip
} from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconDownload
} from '@tabler/icons-react'
import {
  abandonBlockedRun,
  api,
  ApiError,
  type ArtifactStorage,
  type Run,
  type RunEvent
} from './api.js'
import { RunStateMachines } from './StateMachine.js'
import { formatDate, useLanguage, useMessages } from './i18n.js'
import { CopyAction, useRefresh } from './App.js'
import {
  ExecutionStatus,
  PreparationStatus,
  PublicationStatus,
  failureNoticeStatusLabel,
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
  isDownloadableArtifact,
  isRunTerminal,
  phaseElapsed,
  observationAgeMs,
  isObservationStale,
  safeExternalUrl,
  workflowLabel
} from './format.js'

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
            <button
              type="button"
              className="artifact-digest-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? t('collapseDigest') : t('expandDigest')}
              onClick={() => setExpanded((value) => !value)}
            >
              <code>{expanded ? hex : abbreviateDigest(hex)}</code>
              {expanded ? (
                <IconChevronUp size={14} />
              ) : (
                <IconChevronDown size={14} />
              )}
            </button>
            <CopyAction
              value={artifact.digest}
              name={t('copyDigest')}
              copiedName={t('digestCopied')}
            />
          </div>
        </div>
        {isDownloadableArtifact(storage) && (
          <Anchor
            href={`/api/runs/${encodeURIComponent(runId)}/artifact`}
            download
            size="sm"
            className="artifact-download"
          >
            {t('download')}
            <IconDownload size={14} aria-hidden="true" />
          </Anchor>
        )}
      </div>
    </div>
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
      setFailure(
        error instanceof ApiError && error.status === 401
          ? t('abandonWrongToken')
          : t('abandonFailed')
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={t('abandonTitle')} centered>
      <Stack gap="sm">
        <Text size="sm">{t('abandonExplainer')}</Text>
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

/** A failure code, with its meaning on hover when the console knows one.
 *
 * The code stays visible either way: it is what the logs and the Runner use, and an operator
 * searching for it must not have to reconstruct it from a tooltip. A code the console does not
 * recognise renders plainly rather than being guessed at.
 */
function ExplainedCode({
  code,
  className,
  tone = 'error'
}: {
  code: string
  className?: string
  /** `error` for a failure code, `neutral` for a state marker that is not itself a failure. */
  tone?: 'error' | 'neutral'
}): React.JSX.Element {
  const t = useMessages()
  const { explanation } = failureCodeLabel(code, t)
  const label = (
    <span className={className}>
      <Text
        component="span"
        c={tone === 'error' ? 'red' : 'dimmed'}
        size="xs"
        ff="monospace"
      >
        {code}
      </Text>
    </span>
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
  const run = loaded?.runId === runId ? loaded.run : undefined
  const steps = loaded?.runId === runId ? loaded.steps : []
  const events = loaded?.runId === runId ? loaded.events : []
  const error = failure?.runId === runId ? failure.error : undefined
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
    document.title = `${titleRunId} · Review Control Plane`
    return (): void => {
      document.title = 'Review Control Plane'
    }
  }, [titleRunId])
  if (error instanceof ApiError && error.status === 401) throw error
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
            leftSection={<IconArrowLeft size={16} />}
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
  const publicationStarted =
    run !== undefined &&
    ['publishing', 'published', 'failed'].includes(run.publication.status)
  return (
    <Container size="lg" py="xl">
      <Button
        component={Link}
        to={backTo}
        variant="subtle"
        px={0}
        leftSection={<IconArrowLeft size={16} />}
        mb="lg"
      >
        {t('back')}
      </Button>
      {run === undefined ? (
        <p>{t('loadingRun')}</p>
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
            <Group
              gap="lg"
              align="center"
              mt="md"
              className="run-state-summary"
            >
              <span className="workflow-chip">
                {workflowLabel(run.workflow, t)}
              </span>
              <Group gap={6} align="center">
                <Text c="dimmed" size="xs">
                  {t('preparation')}
                </Text>
                <PreparationStatus preparation={run.preparation} />
              </Group>
              <Group gap={6} align="center">
                <Text c="dimmed" size="xs">
                  {t('execution')}
                </Text>
                <ExecutionStatus status={run.execution.status} />
              </Group>
              <Group gap={6} align="center">
                <Text c="dimmed" size="xs">
                  {t('publication')}
                </Text>
                <PublicationStatus status={run.publication.status} />
              </Group>
              {run.failure_code && (
                <Group gap={6} wrap="wrap">
                  <Text c="dimmed" size="xs">
                    {t('failureCode')}:
                  </Text>
                  <ExplainedCode code={run.failure_code} />
                </Group>
              )}
            </Group>
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
              opened={abandoning}
              onClose={() => setAbandoning(false)}
              onDone={async () => {
                setAbandoning(false)
                await load()
              }}
            />
            {run.preparation.expiry_blocked_reason !== null && (
              <Alert
                // A run the system refused to conclude. `Alert` rather than `Paper`: this is a
                // call to act, and it must not look like another content card on the page.
                color="orange"
                variant="light"
                radius="sm"
                p="lg"
                icon={<IconAlertTriangle size={22} />}
                title={t('blockedRunTitle')}
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
                  >
                    <Text size="sm" className="blocked-run-body">
                      {t('blockedRunBody')}
                    </Text>
                    <Button
                      color="orange"
                      variant="filled"
                      size="xs"
                      onClick={() => setAbandoning(true)}
                      data-testid="abandon-run"
                      className="blocked-run-action"
                    >
                      {t('abandonRun')}
                    </Button>
                  </Group>
                  <ExplainedCode
                    code={run.preparation.expiry_blocked_reason}
                    tone="neutral"
                  />
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
                  bullet={<IconClock size={14} />}
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
                    {run.preparation.failure_notice_status !== null && (
                      <>
                        {' · '}
                        {t('preparationNotice')}:{' '}
                        {failureNoticeStatusLabel(
                          run.preparation.failure_notice_status,
                          t
                        )}
                      </>
                    )}
                  </Text>
                </Timeline.Item>
                <Timeline.Item
                  bullet={statusBullet(executionTone(run.execution.status))}
                  color={statusToneColor(executionTone(run.execution.status))}
                  title={<Text fw={500}>{t('execution')}</Text>}
                >
                  {run.execution.started_at === null ? (
                    // Execution has not begun: either preparation has not handed the input to the
                    // Runner yet (nothing to time), or it never will because preparation failed
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
                  {run.artifact_storage !== null && (
                    <div className="artifact-section">
                      <Artifact
                        storage={run.artifact_storage}
                        runId={run.run_id}
                      />
                    </div>
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
                    {publicationStarted && (
                      <Text c="dimmed" size="sm">
                        {/* The publication phase starts when the work is first claimed, not
                            when execution ended: the gap between the two is the coordinator's
                            polling wait and is not publishing time. `publicationStarted` above
                            already guarantees a start and, for a terminal status, an end. */}
                        {formatDate(
                          run.publication.finished_at ??
                            run.publication.started_at ??
                            run.created_at,
                          language
                        )}{' '}
                        ·{' '}
                        {phaseElapsed(
                          run.publication.started_at ?? run.created_at,
                          ['published', 'failed', 'skipped'].includes(
                            run.publication.status
                          )
                            ? run.publication.finished_at
                            : null,
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
                                  {step.failure_message && (
                                    <Text size="sm">
                                      {step.failure_message}
                                    </Text>
                                  )}
                                  <Group gap="sm">
                                    {step.failure_code && (
                                      <Text c="dimmed" size="xs" ff="monospace">
                                        {step.failure_code}
                                      </Text>
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
