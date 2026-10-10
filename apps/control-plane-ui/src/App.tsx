import React from 'react'
import { Link, Route, Routes, useNavigate } from 'react-router-dom'
import {
  ActionIcon,
  AppShell,
  Button,
  Container,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { IconArrowRight, IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react'
import { ApiError, login } from './api.js'
import { formatDate, useLanguage, useMessages } from './i18n.js'
import { PreferenceControls, usePreferences } from './preferences.js'
import { Detail } from './Detail.js'
import { failureReason } from './format.js'
import { Runs } from './Runs.js'

function Login(): React.JSX.Element {
  const t = useMessages()
  const [token, setToken] = React.useState('')
  const [error, setError] = React.useState('')
  return (
    <Container size="xs" py="15vh">
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

export function useRefresh(
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

export function RefreshControls({
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

/** Copies a value and confirms it briefly; used for the run id and the artifact digest. */
export function CopyAction({
  value,
  name,
  copiedName
}: {
  value: string
  name: string
  copiedName: string
}): React.JSX.Element {
  const t = useMessages()
  const [copied, setCopied] = React.useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }
  const text = copied ? copiedName : name
  return (
    <>
      <Tooltip label={copied ? t('copied') : t('copy')}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={text}
          onClick={() => void copy()}
        >
          {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
        </ActionIcon>
      </Tooltip>
      <span className="visually-hidden" aria-live="polite">
        {copied ? copiedName : ''}
      </span>
    </>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {}
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }
  render(): React.ReactNode {
    if (this.state.error instanceof ApiError && this.state.error.status === 401) return <Login />
    if (this.state.error) return <ErrorFallback error={this.state.error} />
    return this.props.children
  }
}

function ErrorFallback({ error }: { error: unknown }): React.JSX.Element {
  const t = useMessages()
  return (
    <Container size="lg" py="xl">
      <Title order={1}>{t('unable')}</Title>
      <Text role="alert" mb="md">
        {t('requestFailed')}
        {failureReason(error, t) && ` ${failureReason(error, t)}`}
      </Text>
      <Button onClick={() => window.location.reload()}>{t('retry')}</Button>
    </Container>
  )
}

export function App(): React.JSX.Element {
  const t = useMessages()
  const navigate = useNavigate()
  const [runIdInput, setRunIdInput] = React.useState('')
  return (
    <>
      <AppShell header={{ height: 58 }}>
        <AppShell.Header>
          <Container size="lg" h="100%" w="100%">
            <Group h="100%" justify="space-between" wrap="nowrap" gap="md">
              <Link className="brand" to="/runs">
                Review Control Plane
              </Link>
              <form
                className="open-run"
                onSubmit={(event) => {
                  event.preventDefault()
                  const requestedRunId = runIdInput.trim()
                  if (requestedRunId) navigate(`/runs/${encodeURIComponent(requestedRunId)}`)
                }}
              >
                <Group gap={6} align="center" wrap="nowrap">
                  <TextInput
                    aria-label={t('goToRunId')}
                    placeholder={t('runIdPlaceholder')}
                    value={runIdInput}
                    size="sm"
                    ff="monospace"
                    onChange={(event) => setRunIdInput(event.currentTarget.value)}
                  />
                  <ActionIcon type="submit" aria-label={t('goToRun')} variant="filled" size={36}>
                    <IconArrowRight size={16} />
                  </ActionIcon>
                </Group>
              </form>
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
