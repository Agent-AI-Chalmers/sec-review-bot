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
  Pagination,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Table,
  Text,
  Timeline,
  Tooltip,
  Title
} from '@mantine/core'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
  IconInbox,
  IconMinus,
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
        <Title order={1}>Review Control Plane</Title>
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
          <PasswordInput
            label={t('accessToken')}
            autoFocus
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
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

function workflowLabel(workflow: string, t: ReturnType<typeof useMessages>): string {
  if (workflow === 'issue-review') return t('workflowIssueReview')
  if (workflow === 'pull-request-review') return t('workflowPullRequestReview')
  if (workflow === 'repository-review') return t('workflowRepositoryReview')
  return workflow
}

type StatusTone = 'waiting' | 'active' | 'complete' | 'failed' | 'neutral'

function statusToneColor(tone: StatusTone): string {
  if (tone === 'active') return 'blue'
  if (tone === 'complete') return 'green'
  if (tone === 'failed') return 'red'
  return 'gray'
}

function StatusText({ label, tone }: { label: string; tone: StatusTone }): React.JSX.Element {
  return (
    <span className="status-text">
      <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function executionTone(status: Run['execution_status']): StatusTone {
  if (status === 'running') return 'active'
  if (status === 'succeeded') return 'complete'
  if (status === 'failed') return 'failed'
  return 'waiting'
}

function publicationTone(status: Run['publication_status']): StatusTone {
  if (status === 'publishing') return 'active'
  if (status === 'published') return 'complete'
  if (status === 'failed') return 'failed'
  if (status === 'pending') return 'waiting'
  return 'neutral'
}

function ExecutionStatus({ status }: { status: Run['execution_status'] }): React.JSX.Element {
  const t = useMessages()
  return <StatusText label={executionStatusLabel(status, t)} tone={executionTone(status)} />
}

function PublicationStatus({ status }: { status: Run['publication_status'] }): React.JSX.Element {
  const t = useMessages()
  return <StatusText label={runPublicationStatusLabel(status, t)} tone={publicationTone(status)} />
}

function statusBullet(tone: StatusTone): React.ReactNode {
  if (tone === 'active') return <IconPlayerPlay size={14} />
  if (tone === 'complete') return <IconCheck size={14} />
  if (tone === 'failed') return <IconAlertTriangle size={14} />
  if (tone === 'neutral') return <IconMinus size={14} />
  return <IconClock size={14} />
}

const PAGE_SIZES: readonly number[] = [10, 20, 50, 100]
/** Mirrors the Control Plane's own default, so an unadorned `/runs` asks for what
 * the server would have returned anyway. */
const DEFAULT_PAGE_SIZE = 50

function Runs(): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const [search, setSearch] = useSearchParams()
  // The Control Plane walks pages forward by cursor only, so remember which cursor
  // each page was opened from in order to offer a previous page. Keyed by cursor
  // rather than by position, so the browser back button cannot desynchronise it.
  const [cursorParents, setCursorParents] = React.useState<Record<string, string>>({})
  const [data, setData] = React.useState<{ runs: Run[]; next_cursor: string | null }>()
  const [error, setError] = React.useState<unknown>()
  const cursor = search.get('cursor') ?? ''
  const previousCursor = cursorParents[cursor]
  const requestedPageSize = Number(search.get('limit') ?? DEFAULT_PAGE_SIZE)
  const pageSize =
    Number.isSafeInteger(requestedPageSize) && requestedPageSize >= 1 && requestedPageSize <= 100
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE
  // State the page size on every request, so the console never depends on the
  // server's own default changing underneath a bookmarked or shared link. A size
  // that the console does not offer is still honoured as an extra option.
  const pageQuery = new URLSearchParams(search)
  pageQuery.set('limit', String(pageSize))
  const query = pageQuery.toString()
  const pageSizeOptions = PAGE_SIZES.includes(pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, pageSize].sort((left, right) => left - right)
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
    setCursorParents({})
    setSearch(next)
  }
  const openCursor = (target: string): void => {
    const next = new URLSearchParams(search)
    if (target) next.set('cursor', target)
    else next.delete('cursor')
    setSearch(next)
  }
  const openNextPage = (): void => {
    const target = data?.next_cursor
    if (target === undefined || target === null) return
    setCursorParents((parents) => ({ ...parents, [target]: cursor }))
    openCursor(target)
  }
  const openPreviousPage = (): void => {
    if (previousCursor === undefined) return
    openCursor(previousCursor)
  }
  // Mantine's pager is numbered, but the read API only walks forward and never
  // reports a total. Use the visited trail for the current position and treat
  // "there is another page" as exactly one page beyond it: `active === total` is
  // what disables the next control, and `active === 1` disables the previous one.
  const page = React.useMemo(() => {
    let number = 1
    let node = cursorParents[cursor]
    while (node !== undefined) {
      number += 1
      if (node === '') break
      node = cursorParents[node]
    }
    return number
  }, [cursorParents, cursor])
  const totalPages = data?.next_cursor != null ? page + 1 : page
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
          <Group aria-label="Run list controls" align="flex-end">
            <NativeSelect
              label={t('workflow')}
              value={search.get('workflow') ?? ''}
              onChange={(event) => update('workflow', event.target.value)}
            >
              <option value="">{t('all')}</option>
              {['issue-review', 'pull-request-review', 'repository-review'].map((value) => (
                <option key={value} value={value}>
                  {workflowLabel(value, t)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              label={t('execution')}
              value={search.get('execution_status') ?? ''}
              onChange={(event) => update('execution_status', event.target.value)}
            >
              <option value="">{t('all')}</option>
              {(
                ['preparing', 'recovering', 'queued', 'running', 'succeeded', 'failed'] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {executionStatusLabel(value, t)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              label={t('publication')}
              value={search.get('publication_status') ?? ''}
              onChange={(event) => update('publication_status', event.target.value)}
            >
              <option value="">{t('all')}</option>
              {(['pending', 'publishing', 'published', 'failed', 'not_required'] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {runPublicationStatusLabel(value, t)}
                  </option>
                )
              )}
            </NativeSelect>
            <NativeSelect
              label={t('perPage')}
              value={String(pageSize)}
              onChange={(event) =>
                // Reuse the filter path: changing how much a page holds invalidates
                // the cursor and the visited-page trail.
                update(
                  'limit',
                  event.target.value === String(DEFAULT_PAGE_SIZE) ? '' : event.target.value
                )
              }
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </NativeSelect>
          </Group>
          <RefreshControls refresh={refresh} refreshing={refreshing} lastChecked={lastChecked} />
        </Group>
      </Box>
      {data === undefined ? (
        <p>{t('loadingRuns')}</p>
      ) : data.runs.length === 0 ? (
        <Stack align="center" gap="xs" py="xl">
          <IconInbox size={40} stroke={1.2} style={{ color: 'var(--mantine-color-dimmed)' }} />
          <Text c="dimmed">{t('emptyRuns')}</Text>
        </Stack>
      ) : (
        <>
          <Paper withBorder radius="sm" className="table-wrap">
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('run')}</Table.Th>
                  <Table.Th>{t('workflow')}</Table.Th>
                  <Table.Th>{t('execution')}</Table.Th>
                  <Table.Th>{t('publication')}</Table.Th>
                  <Table.Th>{t('lastActivity')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.runs.map((run) => (
                  <Table.Tr key={run.run_id}>
                    <Table.Td>
                      <Tooltip label={run.run_id}>
                        <Link to={`/runs/${encodeURIComponent(run.run_id)}`}>
                          {abbreviate(run.run_id, 8, 4)}
                        </Link>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>{workflowLabel(run.workflow, t)}</Table.Td>
                    <Table.Td>
                      <ExecutionStatus status={run.execution_status} />
                    </Table.Td>
                    <Table.Td>
                      <PublicationStatus status={run.publication_status} />
                    </Table.Td>
                    <Table.Td>{formatDate(lastActivity(run), language)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
          {totalPages > 1 && (
            <Pagination.Root
              total={totalPages}
              value={page}
              onPreviousPage={openPreviousPage}
              onNextPage={openNextPage}
              mt="md"
            >
              <Group gap="xs" justify="center">
                <Pagination.Previous aria-label={t('previousPage')} />
                <Pagination.Next aria-label={t('nextPage')} />
              </Group>
            </Pagination.Root>
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
  if (status === 'pending') return t('publicationPending')
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

function abbreviate(value: string, head: number, tail: number): string {
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function lastActivity(run: Run): string {
  return Date.parse(run.publication_updated_at) > Date.parse(run.execution_updated_at)
    ? run.publication_updated_at
    : run.execution_updated_at
}

function abbreviateDigest(digest: string): string {
  return abbreviate(digest.replace(/^sha256:/, ''), 12, 12)
}

function isDownloadableArtifact(value: ArtifactStorage | null): value is ArtifactStorage & {
  status: 'available'
  artifact: NonNullable<ArtifactStorage['artifact']>
} {
  return value?.status === 'available' && value.artifact !== undefined
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
  // Polls while the run is active. The detail page renders no refresh chrome, so
  // the hook's display state (refreshing / lastChecked) is intentionally unused.
  useRefresh(load, !terminal)
  const titleRunId = run?.run_id
  React.useEffect(() => {
    if (titleRunId === undefined) return
    document.title = `${titleRunId} · Review Control Plane`
    return (): void => {
      document.title = 'Review Control Plane'
    }
  }, [titleRunId])
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
  // `publication_updated_at` is the publication row's `updated_at`, and that row is
  // written when the run is admitted. It only means "the publication happened" once
  // the publication has actually started, so never present it before then — a run
  // that is still `pending`, or whose publication was ruled out, has no such moment.
  const publicationStarted =
    run !== undefined && ['publishing', 'published', 'failed'].includes(run.publication_status)
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
            <Title order={1} className="run-id">
              {run.run_id}
            </Title>
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
                    {t('latestError')}:
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
                    {formatDate(run.execution_updated_at, language)}
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
                        {formatDate(run.published_at ?? run.publication_updated_at, language)}
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
                  </div>
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
