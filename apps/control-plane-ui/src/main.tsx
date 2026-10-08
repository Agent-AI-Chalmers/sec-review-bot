import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import {
  AppShell,
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
  Title
} from '@mantine/core'
import { IconArrowLeft, IconCheck, IconClock, IconRefresh } from '@tabler/icons-react'
import { api, ApiError, login, type Run } from './api.js'
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
                      <Badge variant="light" color={run.status === 'failed' ? 'red' : 'blue'}>
                        {run.status}
                      </Badge>
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
  failure_code: string | null
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
            <Badge variant="light" color={run.status === 'failed' ? 'red' : 'blue'}>
              {run.status}
            </Badge>
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
                <Timeline.Item bullet={<IconCheck size={14} />} title={t('published')}>
                  <Text c="dimmed" size="sm">
                    {run.published_at ? formatDate(run.published_at, language) : t('notPublished')}
                  </Text>
                </Timeline.Item>
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
              <Title order={2}>{t('artifact')}</Title>
              <pre>
                {run.artifact_publication === null
                  ? t('noArtifact')
                  : JSON.stringify(run.artifact_publication, null, 2)}
              </pre>
            </Box>
            <Box component="section">
              <Title order={2} mb="sm">
                {t('publicationSteps')}
              </Title>
              {steps.length === 0 ? (
                <Text c="dimmed">{t('noSteps')}</Text>
              ) : (
                <Paper withBorder radius="sm" className="table-wrap">
                  <Table.ScrollContainer minWidth={620}>
                    <Table striped verticalSpacing="sm">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th w="36%">{t('step')}</Table.Th>
                          <Table.Th w="24%">{t('status')}</Table.Th>
                          <Table.Th w="16%" ta="right">
                            {t('failureCount')}
                          </Table.Th>
                          <Table.Th w="24%">{t('latestError')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {steps.map((step) => (
                          <Table.Tr key={step.step_key}>
                            <Table.Td>{step.step_key}</Table.Td>
                            <Table.Td>
                              <Badge
                                variant="light"
                                color={step.status === 'failed' ? 'red' : 'blue'}
                              >
                                {step.status}
                              </Badge>
                            </Table.Td>
                            <Table.Td ta="right" ff="monospace">
                              {step.failure_count}
                            </Table.Td>
                            <Table.Td>{step.failure_code ?? '—'}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Paper>
              )}
            </Box>
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
