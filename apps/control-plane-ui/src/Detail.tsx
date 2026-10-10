import React from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import {
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Timeline,
  Title
} from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconDownload
} from '@tabler/icons-react'
import { api, ApiError, type ArtifactStorage, type Run } from './api.js'
import { formatDate, useLanguage, useMessages } from './i18n.js'
import { CopyAction, useRefresh } from './App.js'
import {
  ExecutionStatus,
  PublicationStatus,
  type PublicationStepStatus,
  artifactStatusColor,
  artifactStatusLabel,
  executionTone,
  publicationStatusColor,
  publicationStatusLabel,
  publicationTone,
  statusBullet,
  statusToneColor
} from './status.js'
import {
  abbreviateDigest,
  failureReason,
  formatBytes,
  isDownloadableArtifact,
  isRunTerminal,
  phaseElapsed,
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
  storage: ArtifactStorage
  runId: string
}): React.ReactNode {
  const t = useMessages()
  const [expanded, setExpanded] = React.useState(false)
  const artifact = storage.artifact
  if (artifact === undefined) {
    if (!storage.message && !storage.error_code) return null
    return (
      <div className="artifact-state">
        {storage.message && <Text size="sm">{storage.message}</Text>}
        {storage.error_code && (
          <Text c={storage.status === 'failed' ? 'red' : 'dimmed'} size="xs" ff="monospace">
            {storage.error_code}
          </Text>
        )}
      </div>
    )
  }
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
              {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
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

export function Detail(): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const { runId = '' } = useParams()
  const location = useLocation()
  // Restore the list's filters and cursor when the reader came from it. A reload or
  // a deep link has no such state, so fall back to an unfiltered first page.
  const listSearch = (location.state as { listSearch?: string } | null)?.listSearch
  const backTo = listSearch ? `/runs?${listSearch}` : '/runs'
  // Both are keyed by run id. React Router keeps this component mounted when only the
  // id changes, so unkeyed state would keep rendering the previous run — and a 404 for
  // the new id would then be reported as a failed refresh of the old one.
  const [loaded, setLoaded] = React.useState<{ runId: string; run: Run; steps: Step[] }>()
  const [failure, setFailure] = React.useState<{ runId: string; error: unknown }>()
  const run = loaded?.runId === runId ? loaded.run : undefined
  const steps = loaded?.runId === runId ? loaded.steps : []
  const error = failure?.runId === runId ? failure.error : undefined
  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [runValue, stepValue] = await Promise.all([
        api<{ run: Run }>(`/runs/${encodeURIComponent(runId)}`),
        api<{ publication_steps: Step[] }>(`/runs/${encodeURIComponent(runId)}/publication-steps`)
      ])
      setLoaded({ runId, run: runValue.run, steps: stepValue.publication_steps })
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
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 10_000)
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
    (step) => step.status !== 'succeeded' || safeExternalUrl(step.remote_object_url) !== undefined
  )
  const publicationIndex = 2 + (run?.artifact_storage === null ? 0 : 1)
  const timelineActive =
    run?.publication_status === 'pending' ? publicationIndex - 1 : publicationIndex
  // `publication_updated_at` is the publication row's `updated_at`, and that row is
  // written when the run is admitted. It only means "the publication happened" once
  // the publication has actually started, so never present it before then — a run
  // that is still `pending`, or whose publication was ruled out, has no such moment.
  const publicationStarted =
    run !== undefined && ['publishing', 'published', 'failed'].includes(run.publication_status)
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
              <Title order={1} className="run-id">
                {run.run_id}
              </Title>
              <CopyAction value={run.run_id} name={t('copyRunId')} copiedName={t('runIdCopied')} />
            </Group>
            <Group gap="lg" align="center" mt="md" className="run-state-summary">
              <Text c="dimmed" size="xs" tt="uppercase">
                {workflowLabel(run.workflow, t)}
              </Text>
              <Group gap={6} align="center">
                <Text c="dimmed" size="xs">
                  {t('execution')}
                </Text>
                <ExecutionStatus status={run.execution_status} />
              </Group>
              <Group gap={6} align="center">
                <Text c="dimmed" size="xs">
                  {t('publication')}
                </Text>
                <PublicationStatus status={run.publication_status} />
              </Group>
              {run.failure_code && (
                <Group gap={6} wrap="wrap">
                  <Text c="dimmed" size="xs">
                    {t('failureCode')}:
                  </Text>
                  <Text c="red" size="xs" ff="monospace">
                    {run.failure_code}
                  </Text>
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
                <Timeline.Item bullet={<IconClock size={14} />} title={t('created')}>
                  <Text c="dimmed" size="sm">
                    {formatDate(run.created_at, language)}
                  </Text>
                </Timeline.Item>
                <Timeline.Item
                  bullet={statusBullet(executionTone(run.execution_status))}
                  color={statusToneColor(executionTone(run.execution_status))}
                  title={<Text fw={500}>{t('execution')}</Text>}
                >
                  <Text c="dimmed" size="sm">
                    {formatDate(run.execution_updated_at, language)} ·{' '}
                    {phaseElapsed(
                      run.execution_updated_at,
                      run.created_at,
                      ['succeeded', 'failed'].includes(run.execution_status),
                      t
                    )}
                  </Text>
                  {run.artifact_storage !== null && (
                    <div className="artifact-section">
                      <Artifact storage={run.artifact_storage} runId={run.run_id} />
                    </div>
                  )}
                </Timeline.Item>
                <Timeline.Item
                  bullet={statusBullet(publicationTone(run.publication_status))}
                  color={statusToneColor(publicationTone(run.publication_status))}
                  title={<Text fw={500}>{t('publication')}</Text>}
                >
                  <div className="publication-summary">
                    {publicationStarted && (
                      <Text c="dimmed" size="sm">
                        {formatDate(run.published_at ?? run.publication_updated_at, language)} ·{' '}
                        {phaseElapsed(
                          run.published_at ?? run.publication_updated_at,
                          run.created_at,
                          ['published', 'failed'].includes(run.publication_status),
                          t
                        )}
                      </Text>
                    )}
                  </div>
                  {publicationOutcomes.length > 0 && (
                    <div className="delivery-list">
                      {publicationOutcomes.map((step) => {
                        const externalUrl = safeExternalUrl(step.remote_object_url)
                        const succeeded = step.status === 'succeeded'
                        return (
                          <div className="delivery-item" key={step.step_key}>
                            {/* Identity on one line: the step's own key belongs beside its
                                status, not stranded on a line of its own. */}
                            <div className="delivery-main">
                              <Badge variant="light" color={publicationStatusColor(step.status)}>
                                {publicationStatusLabel(step.status, t)}
                              </Badge>
                              <code className="delivery-step-key">{step.step_key}</code>
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
                                <IconArrowUpRight size={14} aria-hidden="true" />
                              </Anchor>
                            )}
                            {!succeeded &&
                              (step.failure_message ||
                                step.failure_code ||
                                step.failure_count > 0) && (
                                <div className="delivery-error">
                                  {step.failure_message && (
                                    <Text size="sm">{step.failure_message}</Text>
                                  )}
                                  <Group gap="sm">
                                    {step.failure_code && (
                                      <Text c="dimmed" size="xs" ff="monospace">
                                        {step.failure_code}
                                      </Text>
                                    )}
                                    {step.failure_count > 0 && (
                                      <Text c="dimmed" size="xs">
                                        {t('failedAttempts')}: {step.failure_count}
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
            </Paper>
          </Stack>
        </>
      )}
    </Container>
  )
}
