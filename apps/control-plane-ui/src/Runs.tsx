import React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Container,
  Group,
  Modal,
  NativeSelect,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { IconAlertTriangle, IconInbox } from '@tabler/icons-react'
import {
  api,
  ApiError,
  abandonBlockedRun,
  blockedPreparations,
  type BlockedPreparationExpiry,
  type Run
} from './api.js'
import { formatDate, useLanguage, useMessages } from './i18n.js'
import { CopyAction, RefreshControls, useRefresh } from './App.js'
import {
  EXECUTION_STATUSES,
  ExecutionStatus,
  PREPARATION_STATUSES,
  PreparationStatus,
  PublicationStatus,
  executionStatusLabel,
  preparationStateLabel,
  runPublicationStatusLabel
} from './status.js'
import {
  abbreviate,
  failureReason,
  formatDuration,
  lastActivity,
  workflowLabel
} from './format.js'
import { LIST_RUN_QUERY_PARAMS } from './list-run-query-params.js'

const RANGE_MINUTES: Record<string, number> = {
  '1h': 60,
  '24h': 1_440,
  '7d': 10_080
}
const PAGE_SIZES: readonly number[] = [10, 20, 50, 100]
/** Mirrors the Control Plane's own default, so an unadorned `/runs` asks for what
 * the server would have returned anyway. */
const DEFAULT_PAGE_SIZE = 50
/** sessionStorage key for the visited-page trail, so it survives navigation to a
 * run detail and back (see the cursorParents state below). */
const CURSOR_PARENTS_KEY = 'runs:cursor-parents'

/** The operator decision for one blocked run.
 *
 * The admin token is entered here, held only in this component's state, and sent with the single
 * request. The console backend forwards it and keeps no copy, so closing the dialog (or the tab)
 * leaves nothing behind that could act later. Asking again for every abandonment is deliberate:
 * the action concludes a run and cannot be undone.
 */
function AbandonDialog({
  runId,
  onClose,
  onDone
}: {
  runId: string | null
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
    if (runId === null) return
    setReason('')
    setAdminToken('')
    setFailure(null)
    setSubmitting(false)
  }, [runId])

  const submit = async (): Promise<void> => {
    if (runId === null) return
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
    <Modal
      opened={runId !== null}
      onClose={onClose}
      title={t('abandonTitle')}
      centered
    >
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

export function Runs(): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const [search, setSearch] = useSearchParams()
  // Mirror the latest params so two filters changed in the same tick compose instead of
  // overwriting each other. `setSearchParams`'s functional form does not queue across calls
  // (its `previous` argument is the committed location), and the render closure's `search`
  // is already stale by the second change, so this ref is the only value that reflects a
  // change made moments ago.
  const latestSearch = React.useRef(search)
  latestSearch.current = search
  // The Control Plane walks pages forward by cursor only, so remember which cursor
  // each page was opened from in order to offer a previous page. Keyed by cursor
  // rather than by position, so the browser back button cannot desynchronise it.
  // Persisted in sessionStorage because navigating to a run detail unmounts this
  // component; without it, returning would reset the trail and strand the reader
  // with no Previous control (the Detail "Back to runs" link restores only the URL).
  const [cursorParents, setCursorParents] = React.useState<
    Record<string, string>
  >(() => {
    try {
      return JSON.parse(
        window.sessionStorage.getItem(CURSOR_PARENTS_KEY) ?? '{}'
      )
    } catch {
      return {}
    }
  })
  const [data, setData] = React.useState<{
    runs: Run[]
    next_cursor: string | null
  }>()
  const [error, setError] = React.useState<unknown>()
  // Runs coordination has stopped retrying. They are not part of the run list's normal
  // pagination, and an operator needs to see them before the list, so they load separately and
  // a failure here never hides the list itself.
  const [blocked, setBlocked] = React.useState<BlockedPreparationExpiry[]>([])
  // Which run the operator is currently deciding about, if any.
  const [abandoning, setAbandoning] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    blockedPreparations()
      .then((blocks) => {
        if (!cancelled) setBlocked(blocks)
      })
      .catch(() => {
        // The queue is an operator aid, not a precondition for reading runs; leave it empty.
      })
    return (): void => {
      cancelled = true
    }
  }, [])
  React.useEffect(() => {
    window.sessionStorage.setItem(
      CURSOR_PARENTS_KEY,
      JSON.stringify(cursorParents)
    )
  }, [cursorParents])
  const cursor = search.get('cursor') ?? ''
  const previousCursor = cursorParents[cursor]
  const requestedPageSize = Number(search.get('limit') ?? DEFAULT_PAGE_SIZE)
  const pageSize =
    Number.isSafeInteger(requestedPageSize) &&
    requestedPageSize >= 1 &&
    requestedPageSize <= 100
      ? requestedPageSize
      : DEFAULT_PAGE_SIZE
  // State the page size on every request, so the console never depends on the
  // server's own default changing underneath a bookmarked or shared link. A size
  // that the console does not offer is still honoured as an extra option.
  //
  // Copy only the parameters Control Plane declares (generated from `openapi.yaml`), never
  // the whole URL. The URL also carries UI-only state (`range`), which the API does not
  // accept; forwarding it would send Control Plane a parameter outside its contract.
  const pageQuery = new URLSearchParams()
  for (const name of LIST_RUN_QUERY_PARAMS) {
    const value = search.get(name)
    if (value !== null && value !== '') pageQuery.set(name, value)
  }
  pageQuery.set('limit', String(pageSize))
  const rangeMinutes = RANGE_MINUTES[search.get('range') ?? '']
  if (rangeMinutes !== undefined) {
    // The API takes an absolute instant, but the URL keeps the preset so a shared
    // link keeps sliding. Quantise to the minute so the request string stays
    // stable between renders instead of retriggering the loader on every one.
    const from = new Date(
      Math.floor(Date.now() / 60_000) * 60_000 - rangeMinutes * 60_000
    ).toISOString()
    pageQuery.set('from', from)
  }
  const query = pageQuery.toString()
  const pageSizeOptions = PAGE_SIZES.includes(pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, pageSize].sort((left, right) => left - right)
  const load = React.useCallback(async (): Promise<void> => {
    try {
      setData(
        await api<{ runs: Run[]; next_cursor: string | null }>(`/runs?${query}`)
      )
      setError(undefined)
    } catch (value) {
      setError(value)
    }
  }, [query])
  const { refresh, refreshing, lastChecked } = useRefresh(load)
  // An expired session must reach the sign-in form even when the console still has data
  // to show: nothing will update until it is handled, and the refresh banner cannot say so.
  if (error instanceof ApiError && error.status === 401) throw error
  if (error && data === undefined) throw error
  // Build the next params from the latest ref, write it through, then advance the ref so a
  // second change in the same tick starts from the first change's result. Without this, two
  // filters set together (as a user selecting each in turn can trigger) would leave only the
  // last one applied.
  const replaceSearch = (mutate: (next: URLSearchParams) => void): void => {
    const next = new URLSearchParams(latestSearch.current)
    mutate(next)
    latestSearch.current = next
    setSearch(next)
  }
  const update = (name: string, value: string): void => {
    setCursorParents({})
    replaceSearch((next) => {
      if (value) next.set(name, value)
      else next.delete(name)
      next.delete('cursor')
    })
  }
  const openCursor = (target: string): void => {
    replaceSearch((next) => {
      if (target) next.set('cursor', target)
      else next.delete('cursor')
    })
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
    <Container size="lg" py="xl">
      <Title order={1} mb="lg">
        {t('runs')}
      </Title>
      {blocked.length > 0 && (
        <Alert
          color="orange"
          variant="light"
          mb="md"
          title={t('blockedPreparationsTitle')}
          icon={<IconAlertTriangle size={18} />}
          data-testid="blocked-preparations"
          // A standing queue, not a transient fault: `role="alert"` belongs to the refresh
          // error below, and Mantine's Alert would otherwise claim that role and be the first
          // thing an alert-based assertion sees.
          role="status"
        >
          <Text size="sm" mb="xs">
            {t('blockedPreparationsBody')}
          </Text>
          <Stack gap={6}>
            {blocked.map((block) => (
              <Group key={block.run_id} gap="xs">
                <Text
                  size="sm"
                  ff="monospace"
                  component={Link}
                  to={`/runs/${encodeURIComponent(block.run_id)}`}
                  c="orange.9"
                >
                  {block.run_id}
                </Text>
                <Button
                  size="compact-xs"
                  variant="light"
                  color="orange"
                  onClick={() => setAbandoning(block.run_id)}
                >
                  {t('abandonRun')}
                </Button>
              </Group>
            ))}
          </Stack>
        </Alert>
      )}
      <AbandonDialog
        runId={abandoning}
        onClose={() => setAbandoning(null)}
        onDone={async () => {
          setAbandoning(null)
          try {
            setBlocked(await blockedPreparations())
          } catch {
            // Leaving the stale entry visible is better than hiding the queue entirely.
          }
        }}
      />
      {Boolean(error) && (
        <Text role="alert" c="red" mb="md">
          {t('refreshFailed')}
          {failureReason(error, t) && ` ${failureReason(error, t)}`}
        </Text>
      )}
      <Box className="operations-bar" mb="lg">
        {/*
          One row: the content filters on the left, the compact refresh cluster fixed to the
          right. Page size is not here at all — it lives with the pager below the table, the
          one place where "how many per page" is a meaningful question.
        */}
        <div className="operations-row">
          <Group aria-label="Run list controls" align="flex-end" gap="md">
            <NativeSelect
              w={150}
              label={t('workflow')}
              value={search.get('workflow') ?? ''}
              onChange={(event) => update('workflow', event.target.value)}
            >
              <option value="">{t('all')}</option>
              {['issue-review', 'pull-request-review', 'repository-review'].map(
                (value) => (
                  <option key={value} value={value}>
                    {workflowLabel(value, t)}
                  </option>
                )
              )}
            </NativeSelect>
            <NativeSelect
              w={130}
              label={t('preparation')}
              value={search.get('preparation_status') ?? ''}
              onChange={(event) =>
                update('preparation_status', event.target.value)
              }
            >
              <option value="">{t('all')}</option>
              {PREPARATION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {preparationStateLabel(value, t)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              w={120}
              label={t('execution')}
              value={search.get('execution_status') ?? ''}
              onChange={(event) =>
                update('execution_status', event.target.value)
              }
            >
              <option value="">{t('all')}</option>
              {EXECUTION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {executionStatusLabel(value, t)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              w={130}
              label={t('publication')}
              value={search.get('publication_status') ?? ''}
              onChange={(event) =>
                update('publication_status', event.target.value)
              }
            >
              <option value="">{t('all')}</option>
              {(
                [
                  'pending',
                  'publishing',
                  'published',
                  'failed',
                  'skipped'
                ] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {runPublicationStatusLabel(value, t)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              w={110}
              label={t('timeRange')}
              value={search.get('range') ?? ''}
              onChange={(event) => update('range', event.target.value)}
            >
              <option value="">{t('all')}</option>
              <option value="1h">{t('lastHour')}</option>
              <option value="24h">{t('lastDay')}</option>
              <option value="7d">{t('lastWeek')}</option>
            </NativeSelect>
          </Group>
          <RefreshControls
            refresh={refresh}
            refreshing={refreshing}
            lastChecked={lastChecked}
          />
        </div>
      </Box>
      {data === undefined ? (
        <p>{t('loadingRuns')}</p>
      ) : data.runs.length === 0 ? (
        <Stack align="center" gap="xs" py="xl">
          <IconInbox
            size={40}
            stroke={1.2}
            style={{ color: 'var(--mantine-color-dimmed)' }}
          />
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
                  <Table.Th>{t('preparation')}</Table.Th>
                  <Table.Th>{t('execution')}</Table.Th>
                  <Table.Th>{t('publication')}</Table.Th>
                  <Table.Th>{t('lastActivity')}</Table.Th>
                  <Table.Th>{t('failureCode')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.runs.map((run) => (
                  <Table.Tr key={run.run_id}>
                    <Table.Td>
                      <Group gap={4} align="center" wrap="nowrap">
                        <Tooltip label={run.run_id}>
                          <Link
                            to={`/runs/${encodeURIComponent(run.run_id)}`}
                            state={{ listSearch: search.toString() }}
                          >
                            {abbreviate(run.run_id, 8, 4)}
                          </Link>
                        </Tooltip>
                        <span className="row-action">
                          <CopyAction
                            value={run.run_id}
                            name={t('copyRunId')}
                            copiedName={t('runIdCopied')}
                          />
                        </span>
                      </Group>
                    </Table.Td>
                    <Table.Td>{workflowLabel(run.workflow, t)}</Table.Td>
                    <Table.Td>
                      <PreparationStatus preparation={run.preparation} />
                    </Table.Td>
                    <Table.Td>
                      <ExecutionStatus status={run.execution.status} />
                    </Table.Td>
                    <Table.Td>
                      <PublicationStatus status={run.publication.status} />
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={formatDate(lastActivity(run), language)}>
                        <span>
                          {formatDuration(
                            Date.now() - Date.parse(lastActivity(run)),
                            t
                          )}{' '}
                          {t('ago')}
                        </span>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      {run.failure_code && (
                        <Text c="red" size="xs" ff="monospace">
                          {run.failure_code}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
          {/*
            One footer row, split across the two edges: the page size on the left as an
            inline "Rows per page [50]" phrase, the pager on the right. Both are the same
            height and share a baseline, so "left and right" no longer means a labelled form
            field on one side and bare buttons on the other. On a single page the pager is
            absent and the page size simply stays on the left.
          */}
          <Group
            justify="space-between"
            align="center"
            mt="md"
            wrap="wrap"
            gap="md"
          >
            <Group gap={6} align="center" wrap="nowrap">
              <Text size="sm" c="dimmed">
                {t('perPage')}
              </Text>
              <Select
                aria-label={t('perPage')}
                size="xs"
                w={72}
                value={String(pageSize)}
                allowDeselect={false}
                data={pageSizeOptions.map((size) => String(size))}
                onChange={(value) => {
                  // Reuse the filter path: changing how much a page holds invalidates the
                  // cursor and the visited-page trail.
                  if (value === null) return
                  update(
                    'limit',
                    value === String(DEFAULT_PAGE_SIZE) ? '' : value
                  )
                }}
              />
            </Group>
            {totalPages > 1 && (
              <Pagination.Root
                total={totalPages}
                value={page}
                onPreviousPage={openPreviousPage}
                onNextPage={openNextPage}
              >
                <Group gap="xs" justify="center">
                  <Pagination.Previous aria-label={t('previousPage')} />
                  <Pagination.Next aria-label={t('nextPage')} />
                </Group>
              </Pagination.Root>
            )}
          </Group>
        </>
      )}
    </Container>
  )
}
