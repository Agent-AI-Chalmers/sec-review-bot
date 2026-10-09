import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import {
  AppShell,
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
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
  IconClock,
  IconCopy,
  IconDownload,
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconLoader2,
  IconPlayerPlay,
  IconRefresh
} from '@tabler/icons-react'
import { api, ApiError, login, type ArtifactStorage, type Run } from './api.js'
import { formatDate, LanguageProvider, useLanguage, useMessages } from './i18n.js'
import { PreferenceControls, Preferences, usePreferences } from './preferences.js'
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
  lastChecked,
  autoRefreshEnabled = true
}: {
  refresh: () => void
  refreshing: boolean
  lastChecked: Date | undefined
  autoRefreshEnabled?: boolean
}): React.JSX.Element {
  const { language } = useLanguage()
  const { autoRefresh, refreshInterval, setAutoRefresh, setRefreshInterval } = usePreferences()
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
          checked={autoRefresh && autoRefreshEnabled}
          disabled={!autoRefreshEnabled}
          onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
        />
        <NativeSelect
          aria-label={t('refreshInterval')}
          value={String(refreshInterval)}
          disabled={!autoRefresh || !autoRefreshEnabled}
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
  const { language } = useLanguage()
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
      <Title order={1} mb="lg">
        {t('runs')}
      </Title>
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

function safeExternalUrl(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function publicationStatusLabel(status: string, t: ReturnType<typeof useMessages>): string {
  if (status === 'pending') return t('waiting')
  if (status === 'running') return t('publishingStatus')
  if (status === 'succeeded') return t('statusSucceeded')
  if (status === 'failed') return t('retryPending')
  if (status === 'terminal_failed') return t('failedStatus')
  return status
}

function publicationStatusColor(status: string): string {
  if (status === 'terminal_failed') return 'red'
  if (status === 'failed') return 'yellow'
  if (status === 'running') return 'blue'
  if (status === 'pending') return 'gray'
  if (status === 'succeeded') return 'green'
  return 'gray'
}

function executionStatusLabel(
  status: Run['execution_status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'preparing') return t('statusPreparing')
  if (status === 'recovering') return t('statusRecovering')
  if (status === 'queued') return t('statusQueued')
  if (status === 'running') return t('statusRunning')
  if (status === 'succeeded') return t('statusSucceeded')
  return t('statusFailed')
}

function executionStatusColor(status: Run['execution_status']): string {
  if (status === 'failed') return 'red'
  if (status === 'succeeded') return 'green'
  if (status === 'running') return 'blue'
  return 'gray'
}

function runPublicationStatusLabel(
  status: Run['publication_status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'pending') return t('publicationPending')
  if (status === 'publishing') return t('publishingStatus')
  if (status === 'published') return t('statusPublished')
  if (status === 'failed') return t('failedStatus')
  return t('publicationNotRequired')
}

function runPublicationStatusColor(status: Run['publication_status']): string {
  if (status === 'failed') return 'red'
  if (status === 'published') return 'green'
  if (status === 'publishing') return 'blue'
  return 'gray'
}

function isRunTerminal(run: Run): boolean {
  if (run.execution_status === 'failed') return true
  return (
    run.execution_status === 'succeeded' &&
    ['published', 'failed', 'not_required'].includes(run.publication_status)
  )
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function abbreviateDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, '')
  return `${hex.slice(0, 12)}…${hex.slice(-12)}`
}

function isDownloadableArtifact(value: ArtifactStorage | null): value is ArtifactStorage & {
  status: 'available'
  artifact: NonNullable<ArtifactStorage['artifact']>
} {
  return value?.status === 'available' && value.artifact !== undefined
}

function artifactStatusLabel(
  status: ArtifactStorage['status'],
  t: ReturnType<typeof useMessages>
): string {
  if (status === 'available') return t('artifactAvailable')
  if (status === 'unavailable') return t('notAvailable')
  return t('failedStatus')
}

function artifactStatusColor(status: ArtifactStorage['status']): string {
  if (status === 'available') return 'green'
  if (status === 'failed') return 'red'
  return 'gray'
}

function Artifact({
  storage,
  runId
}: {
  storage: ArtifactStorage
  runId: string
}): React.ReactNode {
  const t = useMessages()
  const [copied, setCopied] = React.useState(false)
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
  const copyDigest = async (): Promise<void> => {
    await navigator.clipboard.writeText(artifact.digest)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="artifact-panel">
      <div className="artifact-summary">
        <Text c="dimmed" size="sm" className="artifact-meta">
          {formatBytes(artifact.size_bytes)}
        </Text>
        {isDownloadableArtifact(storage) && (
          <Tooltip label={t('download')}>
            <ActionIcon
              component="a"
              href={`/api/runs/${encodeURIComponent(runId)}/artifact`}
              download
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={t('download')}
            >
              <IconDownload size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>
      <div className="artifact-technical-details">
        <Text c="dimmed" size="xs">
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
          <Tooltip label={copied ? t('digestCopied') : t('copyDigest')}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={copied ? t('digestCopied') : t('copyDigest')}
              onClick={() => void copyDigest()}
            >
              {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
            </ActionIcon>
          </Tooltip>
          <span className="visually-hidden" aria-live="polite">
            {copied ? t('digestCopied') : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

function Detail(): React.JSX.Element {
  const { language } = useLanguage()
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
  const terminal = run ? isRunTerminal(run) : false
  const { refresh, refreshing, lastChecked } = useRefresh(load, !terminal)
  if (error && run === undefined) throw error
  const publicationOutcomes = steps.filter(
    (step) => step.status !== 'succeeded' || safeExternalUrl(step.remote_object_url) !== undefined
  )
  const singlePublicationUrl =
    publicationOutcomes.length === 1
      ? safeExternalUrl(publicationOutcomes[0]?.remote_object_url ?? null)
      : undefined
  const showPublicationDetails =
    publicationOutcomes.length > 1 ||
    (publicationOutcomes.length === 1 && publicationOutcomes[0]?.status !== 'succeeded')
  const publicationIndex = 2 + (run?.artifact_storage === null ? 0 : 1)
  const timelineActive =
    run?.publication_status === 'pending' ? publicationIndex - 1 : publicationIndex
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
          <div className="run-heading">
            <Text c="dimmed" size="xs" tt="uppercase">
              {run.workflow}
            </Text>
            <Title order={1} className="run-id">
              {run.run_id}
            </Title>
            <Group
              justify="space-between"
              align="flex-end"
              gap="lg"
              mt="md"
              className="run-heading-footer"
            >
              <Group gap="sm" align="center" className="run-state-summary">
                <RunStatusBadge status={run.status} />
                {run.failure_code && (
                  <Group gap={6} wrap="wrap">
                    <Text c="dimmed" size="xs">
                      {t('latestError')}:
                    </Text>
                    <Text c="red" size="xs" ff="monospace">
                      {run.failure_code}
                    </Text>
                  </Group>
                )}
              </Group>
              <RefreshControls
                refresh={refresh}
                refreshing={refreshing}
                lastChecked={lastChecked}
                autoRefreshEnabled={!terminal}
              />
            </Group>
          </div>
          <Stack gap="xl">
            {Boolean(error) && (
              <Text role="alert" c="red">
                {t('refreshFailed')}
              </Text>
            )}
            <Paper component="section" withBorder radius="sm" p="md">
              <Group justify="space-between" align="flex-start" mb="lg">
                <Title order={2}>{t('runProgress')}</Title>
                <div>
                  <Text c="dimmed" size="xs" ta="right">
                    {t('updated')}
                  </Text>
                  <Text size="sm">{formatDate(run.updated_at, language)}</Text>
                </div>
              </Group>
              <Timeline active={timelineActive} bulletSize={24} lineWidth={2}>
                <Timeline.Item bullet={<IconClock size={14} />} title={t('created')}>
                  <Text c="dimmed" size="sm">
                    {formatDate(run.created_at, language)}
                  </Text>
                </Timeline.Item>
                <Timeline.Item
                  bullet={
                    run.execution_status === 'running' ? (
                      <IconLoader2 size={14} className="status-spinner" />
                    ) : (
                      <IconPlayerPlay size={14} />
                    )
                  }
                  color={executionStatusColor(run.execution_status)}
                  title={
                    <Group gap="xs" align="center">
                      <Text fw={500}>{t('execution')}</Text>
                      <Badge variant="light" color={executionStatusColor(run.execution_status)}>
                        {executionStatusLabel(run.execution_status, t)}
                      </Badge>
                    </Group>
                  }
                />
                {run.artifact_storage !== null && (
                  <Timeline.Item
                    bullet={<IconArchive size={14} />}
                    color={artifactStatusColor(run.artifact_storage.status)}
                    title={
                      <Group gap="xs" align="center">
                        <Text fw={500}>{t('artifact')}</Text>
                        <Badge
                          variant="light"
                          color={artifactStatusColor(run.artifact_storage.status)}
                        >
                          {artifactStatusLabel(run.artifact_storage.status, t)}
                        </Badge>
                      </Group>
                    }
                  >
                    <Artifact storage={run.artifact_storage} runId={run.run_id} />
                  </Timeline.Item>
                )}
                <Timeline.Item
                  bullet={
                    run.publication_status === 'publishing' ? (
                      <IconLoader2 size={14} className="status-spinner" />
                    ) : (
                      <IconExternalLink size={14} />
                    )
                  }
                  color={runPublicationStatusColor(run.publication_status)}
                  title={
                    <Group gap="xs" align="center">
                      <Text fw={500}>{t('publication')}</Text>
                      <Badge
                        variant="light"
                        color={runPublicationStatusColor(run.publication_status)}
                      >
                        {runPublicationStatusLabel(run.publication_status, t)}
                      </Badge>
                    </Group>
                  }
                >
                  {(run.published_at || singlePublicationUrl) && (
                    <Group gap="xs" className="publication-summary">
                      {run.published_at && (
                        <Text c="dimmed" size="sm">
                          {formatDate(run.published_at, language)}
                        </Text>
                      )}
                      {run.published_at && singlePublicationUrl && (
                        <Text c="dimmed" size="sm" aria-hidden="true">
                          ·
                        </Text>
                      )}
                      {singlePublicationUrl && (
                        <Anchor
                          href={singlePublicationUrl}
                          target="_blank"
                          rel="noreferrer"
                          size="sm"
                          className="delivery-link"
                        >
                          {t('openExternalLink')}
                          <IconExternalLink size={14} aria-hidden="true" />
                        </Anchor>
                      )}
                    </Group>
                  )}
                  {showPublicationDetails && (
                    <div className="delivery-list">
                      {publicationOutcomes.map((step) => {
                        const externalUrl = safeExternalUrl(step.remote_object_url)
                        const succeeded = step.status === 'succeeded'
                        return (
                          <div className="delivery-item" key={step.step_key}>
                            {publicationOutcomes.length > 1 && (
                              <div className="delivery-main">
                                <Badge variant="light" color={publicationStatusColor(step.status)}>
                                  {publicationStatusLabel(step.status, t)}
                                </Badge>
                              </div>
                            )}
                            {externalUrl && singlePublicationUrl === undefined && (
                              <Anchor
                                component="a"
                                href={externalUrl}
                                target="_blank"
                                rel="noreferrer"
                                size="sm"
                                className="delivery-link"
                              >
                                {t('openExternalLink')}
                                <IconExternalLink size={14} aria-hidden="true" />
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
                            {(publicationOutcomes.length > 1 || !succeeded) && (
                              <code className="delivery-step-key">{step.step_key}</code>
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
  <LanguageProvider>
    <Preferences>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Preferences>
  </LanguageProvider>
)
