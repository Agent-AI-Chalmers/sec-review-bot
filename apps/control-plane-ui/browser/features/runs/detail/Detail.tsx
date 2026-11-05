import React from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { Button, Container, Group, Stack, Text, Title } from '@mantine/core'
import { IconArrowLeft } from '@tabler/icons-react'
import { ApiError, throwIfUnauthorized } from '../api.js'
import { useRunDetail } from './useRunDetail.js'
import { RunJump } from '../RunJump.js'
import { RunSummary } from './RunSummary.js'
import { RunDecisions } from './RunDecisions.js'
import { RunProgress } from './RunProgress.js'
import { useMessages } from '../../../shared/i18n.js'
import { useNow } from '../../../shared/useNow.js'
import { LoadingState } from '../../../shared/StateMessage.js'
import { failureReason } from '../format.js'
import { ICON_SIZE } from '../../../shared/design.js'

export function Detail(): React.JSX.Element {
  const t = useMessages()
  const now = useNow()
  const { runId = '' } = useParams()
  const location = useLocation()
  // Restore the list's filters and cursor when the reader came from it. A reload or
  // a deep link has no such state, so fall back to an unfiltered first page.
  const listSearch = (location.state as { listSearch?: string } | null)
    ?.listSearch
  const backTo = listSearch ? `/runs?${listSearch}` : '/runs'
  const { run, steps, events, error, load, terminal } = useRunDetail(runId)
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
          <RunSummary run={run} />
          <Stack gap="xl">
            {Boolean(error) && (
              <Text role="alert" c="red">
                {t('refreshFailed')}
                {failureReason(error, t) && ` ${failureReason(error, t)}`}
              </Text>
            )}
            <RunDecisions run={run} events={events} now={now} onDone={load} />
            <RunProgress run={run} steps={steps} events={events} />
          </Stack>
        </>
      )}
    </Container>
  )
}
