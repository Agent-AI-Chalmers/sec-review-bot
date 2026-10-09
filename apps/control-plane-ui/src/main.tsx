import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import {
  AppShell,
  ActionIcon,
  Badge,
  Box,
  Button,
  Collapse,
  Container,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  Timeline,
  Tooltip,
  Title
} from '@mantine/core'
import {
  IconArchive,
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconLoader2,
  IconRefresh
} from '@tabler/icons-react'
import { api, ApiError, login, type ArtifactPublication, type Run } from './api.js'
import {
  formatDate,
  PreferenceControls,
  Preferences,
  useMessages,
  usePreferences
} from './preferences.js'
import './styles.css'
import '@mantine/core/styles.css'

function Login(): React.JSX.Element {
  const t = useMessages()
  const [token, setToken] = React.useState('')
  const [error, setError] = React.useState('')
  return (
    <Container component="main" size="xs" py="15vh">
      <Paper withBorder p="xl" radius="sm">
        <Title order={1}>Control Plane</Title>
        <Text c="dimmed" mt="xs">
          {t('signInHint')}
        </Text>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void login(token).then(
              () => {
                window.location.href = '/runs'
              },
              () => setError(t('denied'))
            )
          }}
        >
          <label>
            {t('accessToken')}
            <input
              autoFocus
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <Button type="submit">{t('signIn')}</Button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Paper>
    </Container>
  )
}

function useRefresh(
  load: () => Promise<void>,
  enabled = true
): {
  refresh: () => void
  refreshing: boolean
  lastChecked: Date | undefined
} {
  const { autoRefresh, refreshInterval } = usePreferences()
  const [refreshing, setRefreshing] = React.useState(false)
  const [lastChecked, setLastChecked] = React.useState<Date>()
  const inFlight = React.useRef(false)
  const pending = React.useRef(false)
  const loadRef = React.useRef(load)
  loadRef.current = load
  const refresh = React.useCallback(function runRefresh(): void {
    if (inFlight.current) {
      pending.current = true
      return
    }
    inFlight.current = true
    setRefreshing(true)
    void loadRef.current().finally(() => {
      inFlight.current = false
      setRefreshing(false)
      setLastChecked(new Date())
      if (pending.current) {
        pending.current = false
        runRefresh()
      }
    })
  }, [])
  React.useEffect(() => {
    refresh()
  }, [refresh, load])
  React.useEffect(() => {
    if (!autoRefresh || !enabled) return
    const check = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const timer = window.setInterval(check, refreshInterval)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return (): void => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [autoRefresh, enabled, refresh, refreshInterval])
  return { refresh, refreshing, lastChecked }
}

function RefreshControls({
  refresh,
  refreshing,
  lastChecked
}: {
  refresh: () => void
  refreshing: boolean
  lastChecked: Date | undefined
}): React.JSX.Element {
  const { language, autoRefresh, refreshInterval, setAutoRefresh, setRefreshInterval } =
    usePreferences()
  const t = useMessages()
  return (
    <Stack gap={4} align="flex-end" className="refresh-controls">
      <Text c="dimmed" size="xs" ta="right">
        {t('lastChecked')}:{' '}
        {lastChecked ? formatDate(lastChecked.toISOString(), language) : t('neverChecked')}
      </Text>
      <Group gap="sm" wrap="nowrap">
        <Switch
          label={t('autoRefresh')}
          checked={autoRefresh}
          onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
        />
        <NativeSelect
          aria-label={t('refreshInterval')}
          value={String(refreshInterval)}
          disabled={!autoRefresh}
          onChange={(event) =>
            setRefreshInterval(Number(event.currentTarget.value) as 5000 | 15000 | 30000 | 60000)
          }
        >
          <option value="5000">5s</option>
          <option value="15000">15s</option>
          <option value="30000">30s</option>
          <option value="60000">1m</option>
        </NativeSelect>
        <Button
          variant="default"
          leftSection={<IconRefresh size={16} />}
          loading={refreshing}
          onClick={refresh}
        >
          {t('refresh')}
        </Button>
      </Group>
    </Stack>
  )
}

function RunStatusBadge({ status }: { status: string }): React.JSX.Element {
  const t = useMessages()
  const waiting = ['preparing', 'recovering', 'queued'].includes(status)
  const active = ['running', 'publishing'].includes(status)
  const complete = ['succeeded', 'published'].includes(status)
  const label = ((): string => {
    if (status === 'preparing') return t('statusPreparing')
    if (status === 'recovering') return t('statusRecovering')
    if (status === 'queued') return t('statusQueued')
    if (status === 'running') return t('statusRunning')
    if (status === 'succeeded') return t('statusSucceeded')
    if (status === 'publishing') return t('statusPublishing')
    if (status === 'published') return t('statusPublished')
    if (status === 'failed') return t('statusFailed')
    return status
  })()
  const icon = waiting ? (
    <IconClock size={12} />
  ) : active ? (
    <IconLoader2 size={12} className="status-spinner" />
  ) : complete ? (
    <IconCheck size={12} />
  ) : (
    <IconAlertTriangle size={12} />
  )
  return (
    <Badge
      variant="light"
      color={waiting ? 'gray' : active ? 'blue' : complete ? 'green' : 'red'}
      leftSection={icon}
    >
      {label}
    </Badge>
  )
}

function Runs(): React.JSX.Element {
  const { language } = usePreferences()
  const t = useMessages()
  const [search, setSearch] = useSearchParams()
  const [data, setData] = React.useState<{ runs: Run[]; next_cursor: string | null }>()
  const [error, setError] = React.useState<unknown>()
  const query = search.toString()
  const load = React.useCallback(async (): Promise<void> => {
    try {
      setData(await api<{ runs: Run[]; next_cursor: string | null }>(`/runs?${query}`))
      setError(undefined)
    } catch (value) {
      setError(value)
    }
  }, [query])
  const { refresh, refreshing, lastChecked } = useRefresh(load)
  if (error && data === undefined) throw error
  const update = (name: string, value: string): void => {
    const next = new URLSearchParams(search)
    if (value) next.set(name, value)
    else next.delete(name)
    next.delete('cursor')
    setSearch(next)
  }
  return (
    <Container component="main" size="lg" py="xl">
      <Box mb="lg">
        <Text c="dimmed" size="xs" tt="uppercase">
          Review Control Plane
        </Text>
        <Title order={1}>{t('runs')}</Title>
      </Box>
      {Boolean(error) && (
        <Text role="alert" c="red" mb="md">
          {t('refreshFailed')}
        </Text>
      )}
      <Box className="operations-bar" mb="lg">
        <Group justify="space-between" align="flex-end" gap="lg">
          <Group aria-label="Run filters" align="flex-end">
            <NativeSelect
              label={t('status')}
              value={search.get('status') ?? ''}
              onChange={(event) => update('status', event.target.value)}
            >
              <option value="">{t('all')}</option>
              {[
                'preparing',
                'recovering',
                'queued',
                'running',
                'succeeded',
                'publishing',
                'published',
                'failed'
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </NativeSelect>
            <NativeSelect
              label={t('workflow')}
              value={search.get('workflow') ?? ''}
              onChange={(event) => update('workflow', event.target.value)}
            >
              <option value="">{t('all')}</option>
              {['issue-review', 'pull-request-review', 'repository-review'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </NativeSelect>
          </Group>
          <RefreshControls refresh={refresh} refreshing={refreshing} lastChecked={lastChecked} />
        </Group>
      </Box>
      {data === undefined ? (
        <p>{t('loadingRuns')}</p>
      ) : data.runs.length === 0 ? (
        <p className="empty">{t('emptyRuns')}</p>
      ) : (
        <>
          <Paper withBorder radius="sm" className="table-wrap">
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('run')}</Table.Th>
                  <Table.Th>{t('workflow')}</Table.Th>
                  <Table.Th>{t('status')}</Table.Th>
                  <Table.Th>{t('updated')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.runs.map((run) => (
                  <Table.Tr key={run.run_id}>
                    <Table.Td>
                      <Link to={`/runs/${encodeURIComponent(run.run_id)}`}>{run.run_id}</Link>
                    </Table.Td>
                    <Table.Td>{run.workflow}</Table.Td>
                    <Table.Td>
                      <RunStatusBadge status={run.status} />
                    </Table.Td>
                    <Table.Td>{formatDate(run.updated_at, language)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
          {data.next_cursor && (
            <Button
              variant="default"
              className="next"
              onClick={() => {
                const next = new URLSearchParams(search)
                next.set('cursor', data.next_cursor ?? '')
                setSearch(next)
              }}
            >
              {t('nextPage')}
            </Button>
          )}
        </>
      )}
    </Container>
  )
}

interface Step {
  step_key: string
  status: string
  failure_count: number
  remote_object_url: string | null
  failure_code: string | null
  failure_message: string | null
}

function publicationStepLabel(stepKey: string, t: ReturnType<typeof useMessages>): string {
  if (stepKey === 'pull-request:review') return t('pullRequestReview')
  if (stepKey === 'issue:draft-pr') return t('draftPullRequest')
  if (stepKey === 'issue:summary-comment') return t('issueSummaryComment')
  if (stepKey === 'repository:summary-issue') return t('repositorySummaryIssue')
  if (stepKey === 'repository:summary-comment') return t('repositorySummaryComment')
  if (stepKey.startsWith('repository:delivery:')) return t('fixPullRequest')
  return stepKey
}

function safeExternalUrl(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      (url.hostname === 'github.com' || url.hostname.endsWith('.github.com'))
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function publicationStatusLabel(status: string, t: ReturnType<typeof useMessages>): string {
  if (status === 'pending') return t('waiting')
  if (status === 'running') return t('publishingStatus')
  if (status === 'failed') return t('retryPending')
  if (status === 'terminal_failed') return t('failedStatus')
  return status
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function isDownloadableArtifact(value: ArtifactPublication | null): value is ArtifactPublication & {
  status: 'published'
  artifact: NonNullable<ArtifactPublication['artifact']>
} {
  return value?.status === 'published' && value.artifact !== undefined
}

function Artifact({
  publication,
  runId
}: {
  publication: ArtifactPublication
  runId: string
}): React.JSX.Element {
  const t = useMessages()
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const artifact = publication.artifact
  if (artifact === undefined) {
    return (
      <Paper withBorder radius="sm" p="md">
        <Group gap="sm">
          <Badge variant="light" color={publication.status === 'failed' ? 'red' : 'gray'}>
            {publication.status}
          </Badge>
          {publication.error_code && <Text>{publication.error_code}</Text>}
        </Group>
      </Paper>
    )
  }
  const copyDigest = async (): Promise<void> => {
    await navigator.clipboard.writeText(artifact.digest)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Paper withBorder radius="sm" className="artifact-panel">
      <div className="artifact-summary">
        <Group gap="sm" wrap="nowrap" className="artifact-identity">
          <IconArchive size={20} aria-hidden="true" />
          <div>
            <Text fw={600}>{t('diagnosticBundle')}</Text>
            <Text c="dimmed" size="sm" className="artifact-meta">
              {t('artifactPublished')} <span aria-hidden="true">·</span>{' '}
              {formatBytes(artifact.size_bytes)}
            </Text>
          </div>
        </Group>
        <Group gap="xs" wrap="nowrap" justify="space-between" className="artifact-actions">
          {isDownloadableArtifact(publication) && (
            <Button
              component="a"
              href={`/api/runs/${encodeURIComponent(runId)}/artifact`}
              download
              variant="default"
              leftSection={<IconDownload size={16} />}
            >
              {t('download')}
            </Button>
          )}
          <Button
            variant="subtle"
            rightSection={detailsOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
            aria-expanded={detailsOpen}
            aria-controls="artifact-technical-details"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? t('hideDetails') : t('details')}
          </Button>
        </Group>
      </div>
      <Collapse expanded={detailsOpen}>
        <dl id="artifact-technical-details" className="artifact-technical-details">
          <div>
            <dt>{t('artifactMediaType')}</dt>
            <dd>{artifact.media_type}</dd>
          </div>
          <div>
            <dt>{t('sha256')}</dt>
            <dd className="artifact-digest-row">
              <code>{artifact.digest.replace(/^sha256:/, '')}</code>
              <Tooltip label={copied ? t('digestCopied') : t('copyDigest')}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={copied ? t('digestCopied') : t('copyDigest')}
                  onClick={() => void copyDigest()}
                >
                  {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
                </ActionIcon>
              </Tooltip>
              <span className="visually-hidden" aria-live="polite">
                {copied ? t('digestCopied') : ''}
              </span>
            </dd>
          </div>
        </dl>
      </Collapse>
    </Paper>
  )
}

function Detail(): React.JSX.Element {
  const { language } = usePreferences()
  const t = useMessages()
  const { runId = '' } = useParams()
  const [run, setRun] = React.useState<Run>()
  const [steps, setSteps] = React.useState<Step[]>([])
  const [error, setError] = React.useState<unknown>()
  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [runValue, stepValue] = await Promise.all([
        api<{ run: Run }>(`/runs/${encodeURIComponent(runId)}`),
        api<{ publication_steps: Step[] }>(`/runs/${encodeURIComponent(runId)}/publication-steps`)
      ])
      setRun(runValue.run)
      setSteps(stepValue.publication_steps)
      setError(undefined)
    } catch (value) {
      setError(value)
    }
  }, [runId])
  const terminal = run ? ['published', 'failed'].includes(run.status) : false
  const { refresh, refreshing, lastChecked } = useRefresh(load, !terminal)
  if (error && run === undefined) throw error
  const publicationOutcomes = steps.filter(
    (step) => step.status !== 'succeeded' || safeExternalUrl(step.remote_object_url) !== undefined
  )
  return (
    <Container component="main" size="lg" py="xl">
      <Button
        component={Link}
        to="/runs"
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
          <Group justify="space-between" align="flex-start" mb="md">
            <div>
              <Text c="dimmed" size="xs" tt="uppercase">
                {run.workflow}
              </Text>
              <Title order={1} className="run-id">
                {run.run_id}
              </Title>
            </div>
            <RunStatusBadge status={run.status} />
          </Group>
          <Box className="operations-bar detail-operations" mb="xl">
            <RefreshControls refresh={refresh} refreshing={refreshing} lastChecked={lastChecked} />
          </Box>
          <Stack gap="xl">
            {Boolean(error) && (
              <Text role="alert" c="red">
                {t('refreshFailed')}
              </Text>
            )}
            <Paper component="section" withBorder radius="sm" p="md">
              <Group justify="space-between" align="flex-start" mb="lg">
                <Title order={2}>{t('timeline')}</Title>
                <div>
                  <Text c="dimmed" size="xs" ta="right">
                    {t('updated')}
                  </Text>
                  <Text size="sm">{formatDate(run.updated_at, language)}</Text>
                </div>
              </Group>
              <Timeline active={run.published_at ? 1 : 0} bulletSize={24} lineWidth={2}>
                <Timeline.Item bullet={<IconClock size={14} />} title={t('created')}>
                  <Text c="dimmed" size="sm">
                    {formatDate(run.created_at, language)}
                  </Text>
                </Timeline.Item>
                {run.published_at && (
                  <Timeline.Item bullet={<IconCheck size={14} />} title={t('publicationCompleted')}>
                    <Text c="dimmed" size="sm">
                      {formatDate(run.published_at, language)}
                    </Text>
                  </Timeline.Item>
                )}
              </Timeline>
              {run.failure_code && (
                <Box mt="md">
                  <Text c="dimmed" size="xs">
                    {t('failure')}
                  </Text>
                  <Text c="red" mt={2}>
                    {run.failure_code}
                  </Text>
                </Box>
              )}
            </Paper>
            <Box component="section">
              <Title order={2} mb="sm">
                {t('artifact')}
              </Title>
              {run.artifact_publication === null ? (
                <Text c="dimmed">{t('noArtifact')}</Text>
              ) : (
                <Artifact publication={run.artifact_publication} runId={run.run_id} />
              )}
            </Box>
            {publicationOutcomes.length > 0 && (
              <Box component="section">
                <Title order={2} mb="sm">
                  {t('publicationResults')}
                </Title>
                <Paper withBorder radius="sm" className="delivery-list">
                  {publicationOutcomes.map((step) => {
                    const externalUrl = safeExternalUrl(step.remote_object_url)
                    const succeeded = step.status === 'succeeded'
                    return (
                      <div className="delivery-item" key={step.step_key}>
                        <div className="delivery-main">
                          <Text fw={600}>{publicationStepLabel(step.step_key, t)}</Text>
                          {!succeeded && (
                            <Badge
                              variant="light"
                              color={step.status === 'terminal_failed' ? 'red' : 'yellow'}
                            >
                              {publicationStatusLabel(step.status, t)}
                            </Badge>
                          )}
                        </div>
                        {externalUrl && (
                          <Button
                            component="a"
                            href={externalUrl}
                            target="_blank"
                            rel="noreferrer"
                            variant="subtle"
                            rightSection={<IconExternalLink size={16} />}
                          >
                            {t('openOnGitHub')}
                          </Button>
                        )}
                        {!succeeded && (step.failure_message || step.failure_code) && (
                          <div className="delivery-error">
                            {step.failure_message && <Text size="sm">{step.failure_message}</Text>}
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
                </Paper>
              </Box>
            )}
          </Stack>
        </>
      )}
    </Container>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {}
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }
  render(): React.ReactNode {
    if (this.state.error instanceof ApiError && this.state.error.status === 401) return <Login />
    if (this.state.error) return <ErrorFallback />
    return this.props.children
  }
}
function ErrorFallback(): React.JSX.Element {
  const t = useMessages()
  return (
    <Container component="main" size="lg" py="xl">
      <Title order={1}>{t('unable')}</Title>
      <Text role="alert">{t('requestFailed')}</Text>
    </Container>
  )
}
function App(): React.JSX.Element {
  return (
    <>
      <AppShell header={{ height: 58 }}>
        <AppShell.Header>
          <Container size="lg" h="100%" w="100%">
            <Group h="100%" justify="space-between">
              <Link className="brand" to="/runs">
                Review Control Plane
              </Link>
              <PreferenceControls />
            </Group>
          </Container>
        </AppShell.Header>
        <AppShell.Main>
          <ErrorBoundary>
            <Routes>
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:runId" element={<Detail />} />
              <Route path="*" element={<Runs />} />
            </Routes>
          </ErrorBoundary>
        </AppShell.Main>
      </AppShell>
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <Preferences>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </Preferences>
)
