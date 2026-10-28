import React from 'react'
import { Link, Route, Routes, useLocation } from 'react-router-dom'
import {
  AppShell,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title
} from '@mantine/core'
import { IconFileText, IconListDetails, IconBrain } from '@tabler/icons-react'
import { ApiError } from '../shared/api-client.js'
import { login } from './session-api.js'
import { useMessages } from '../shared/i18n.js'
import { PreferenceControls } from './preferences.js'
import { failureReason } from '../shared/format.js'
import { ICON_SIZE } from '../shared/design.js'

const Runs = React.lazy(async () => ({
  default: (await import('../features/runs/Runs.js')).Runs
}))
const Detail = React.lazy(async () => ({
  default: (await import('../features/runs/Detail.js')).Detail
}))
const RunFilesPage = React.lazy(async () => ({
  default: (await import('../features/runs/RunFilesViewer.js')).RunFilesPage
}))
const Memory = React.lazy(async () => ({
  default: (await import('../features/memory/Memory.js')).Memory
}))
const MemoryFilesPage = React.lazy(async () => ({
  default: (await import('../features/memory/MemoryViewerPage.js'))
    .MemoryFilesPage
}))
const MemoryRevisionDiffPage = React.lazy(async () => ({
  default: (await import('../features/memory/MemoryViewerPage.js'))
    .MemoryRevisionDiffPage
}))
const RevisionTranscriptPage = React.lazy(async () => ({
  default: (await import('../features/memory/MemoryViewerPage.js'))
    .RevisionTranscriptPage
}))
const ExtractionTranscriptPage = React.lazy(async () => ({
  default: (await import('../features/memory/MemoryViewerPage.js'))
    .ExtractionTranscriptPage
}))
const Viewer = React.lazy(async () => ({
  default: (await import('../features/viewer/Viewer.js')).Viewer
}))

function RouteFallback(): React.JSX.Element {
  return (
    <Center mih="40vh">
      <Loader size="sm" />
    </Center>
  )
}

function Login(): React.JSX.Element {
  const t = useMessages()
  const [token, setToken] = React.useState('')
  const [error, setError] = React.useState('')
  return (
    <Container size="xs" py="15vh">
      <Paper withBorder p="xl" radius="sm">
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

class ErrorBoundary extends React.Component<
  {
    children: React.ReactNode
    /** Reports that a 401 has replaced the routes with the sign-in form, so the
     * shell can stop offering controls that need a session. */
    onUnauthorized: (unauthorized: boolean) => void
  },
  { error?: unknown }
> {
  state: { error?: unknown } = {}
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }
  componentDidMount(): void {
    this.report()
  }
  componentDidUpdate(): void {
    this.report()
  }
  report(): void {
    this.props.onUnauthorized(
      this.state.error instanceof ApiError && this.state.error.status === 401
    )
  }
  render(): React.ReactNode {
    if (this.state.error instanceof ApiError && this.state.error.status === 401)
      return <Login />
    if (this.state.error) return <ErrorFallback error={this.state.error} />
    return this.props.children
  }
}

function ErrorFallback({ error }: { error: unknown }): React.JSX.Element {
  const t = useMessages()
  return (
    <div className="error-fallback">
      <Stack align="center" gap="sm">
        <Title order={1} ta="center">
          {t('unable')}
        </Title>
        <Text role="alert" ta="center" c="dimmed" maw={560}>
          {t('requestFailed')}
          {failureReason(error, t) && ` ${failureReason(error, t)}`}
        </Text>
        <Button mt="xs" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </Stack>
    </div>
  )
}

function NotFound(): React.JSX.Element {
  const t = useMessages()
  return (
    <div className="error-fallback">
      <Stack align="center" gap="sm">
        <Title order={1}>404</Title>
        <Text ta="center" c="dimmed">
          {t('pageNotFound')}
        </Text>
        <Button component={Link} to="/runs" mt="xs">
          {t('backToRuns')}
        </Button>
      </Stack>
    </div>
  )
}

export function App(): React.JSX.Element {
  const t = useMessages()
  const location = useLocation()
  const [unauthorized, setUnauthorized] = React.useState(false)
  const activeSection = location.pathname.startsWith('/memory')
    ? 'memory'
    : location.pathname.startsWith('/viewer')
      ? 'viewer'
      : 'runs'
  return (
    <>
      <AppShell header={{ height: 58 }}>
        <AppShell.Header>
          <Container size="lg" h="100%" w="100%">
            <Group h="100%" justify="space-between" wrap="nowrap" gap="md">
              <Group gap="xs" wrap="nowrap" className="primary-nav">
                <Link className="brand" to="/runs">
                  Control Plane UI
                </Link>
                <Button
                  component={Link}
                  to="/runs"
                  variant="subtle"
                  size="compact-sm"
                  className="primary-nav-link"
                  data-active={activeSection === 'runs' ? 'true' : undefined}
                  aria-current={activeSection === 'runs' ? 'page' : undefined}
                  aria-label={t('runs')}
                  leftSection={<IconListDetails size={ICON_SIZE.md} />}
                >
                  <span className="primary-nav-label">{t('runs')}</span>
                </Button>
                <Button
                  component={Link}
                  to="/memory"
                  variant="subtle"
                  size="compact-sm"
                  className="primary-nav-link"
                  data-active={activeSection === 'memory' ? 'true' : undefined}
                  aria-current={activeSection === 'memory' ? 'page' : undefined}
                  aria-label={t('memory')}
                  leftSection={<IconBrain size={ICON_SIZE.md} />}
                >
                  <span className="primary-nav-label">{t('memory')}</span>
                </Button>
                <Button
                  component={Link}
                  to="/viewer"
                  variant="subtle"
                  size="compact-sm"
                  className="primary-nav-link"
                  data-active={activeSection === 'viewer' ? 'true' : undefined}
                  aria-current={activeSection === 'viewer' ? 'page' : undefined}
                  aria-label={t('viewerNav')}
                  leftSection={<IconFileText size={ICON_SIZE.md} />}
                >
                  <span className="primary-nav-label">{t('viewerNav')}</span>
                </Button>
              </Group>
              <PreferenceControls signedIn={!unauthorized} />
            </Group>
          </Container>
        </AppShell.Header>
        <AppShell.Main>
          <ErrorBoundary onUnauthorized={setUnauthorized}>
            <React.Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/runs" element={<Runs />} />
                <Route path="/runs/:runId" element={<Detail />} />
                <Route path="/runs/:runId/files" element={<RunFilesPage />} />
                <Route path="/memory" element={<Memory />} />
                <Route
                  path="/memory/revisions/:revision/tree"
                  element={<MemoryFilesPage />}
                />
                <Route
                  path="/memory/revisions/:revision/diff"
                  element={<MemoryRevisionDiffPage />}
                />
                <Route
                  path="/memory/revisions/:revision/transcript"
                  element={<RevisionTranscriptPage />}
                />
                <Route
                  path="/memory/extractions/:extractionId/transcript"
                  element={<ExtractionTranscriptPage />}
                />
                <Route path="/viewer" element={<Viewer />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </React.Suspense>
          </ErrorBoundary>
        </AppShell.Main>
      </AppShell>
    </>
  )
}
