import React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Box,
  Button,
  Collapse,
  Container,
  Group,
  NativeSelect,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
  Tooltip
} from '@mantine/core'
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconChevronDown,
  IconInbox
} from '@tabler/icons-react'
import {
  api,
  parkedRuns,
  throwIfUnauthorized,
  type ParkedRun,
  type Run
} from './api.js'
import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import { CopyAction } from '../../shared/CopyAction.js'
import { RefreshControls, useRefresh } from '../../shared/refresh.js'
import { EmptyState, LoadingState } from '../../shared/StateMessage.js'
import {
  EXECUTION_STATUSES,
  ExecutionStatus,
  PREPARATION_STATUSES,
  PreparationStatus,
  PublicationStatus,
  axisLabel,
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
import { LIST_RUN_QUERY_PARAMS } from '../../../shared/list-run-query-params.js'
import { PlatformMark } from './PlatformMark.js'
import { ICON_SIZE } from '../../shared/design.js'
import { RunJump } from './RunJump.js'

const RANGE_MINUTES: Record<string, number> = {
  '1h': 60,
  '24h': 1_440,
  '7d': 10_080
}
const PAGE_SIZES: readonly number[] = [10, 20, 50, 100]
/** Mirrors Review Runs' own default, so an unadorned `/runs` asks for what
 * the server would have returned anyway. */
const DEFAULT_PAGE_SIZE = 50
/** sessionStorage key for the visited-page trail, so it survives navigation to a
 * run detail and back (see the cursorParents state below). */
const CURSOR_PARENTS_KEY = 'runs:cursor-parents'

export function Runs(): React.JSX.Element {
  const { language } = useLanguage()
  const t = useMessages()
  const [search, setSearch] = useSearchParams()
  const [moreFiltersOpened, setMoreFiltersOpened] = React.useState(() =>
    search.has('range')
  )
  // Mirror the latest params so two filters changed in the same tick compose instead of
  // overwriting each other. `setSearchParams`'s functional form does not queue across calls
  // (its `previous` argument is the committed location), and the render closure's `search`
  // is already stale by the second change, so this ref is the only value that reflects a
  // change made moments ago.
  const latestSearch = React.useRef(search)
  latestSearch.current = search
  // Review Runs walks pages forward by cursor only, so remember which cursor
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
  const [auxiliaryError, setAuxiliaryError] = React.useState<unknown>()
  // Runs coordination has stopped retrying on any axis. They are not part of the run list's
  // normal pagination, and an operator needs to see them before the list, so they load
  // separately and a failure here never hides the list itself.
  const [blocked, setBlocked] = React.useState<ParkedRun[]>([])
  const [showParkedDetails, setShowParkedDetails] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    parkedRuns()
      .then((blocks) => {
        if (!cancelled) setBlocked(blocks)
      })
      .catch((value: unknown) => {
        if (!cancelled) setAuxiliaryError(value)
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
  // Copy only the parameters Review Runs declares (generated from `openapi.yaml`), never
  // the whole URL. The URL also carries UI-only state (`range`), which the API does not
  // accept; forwarding it would send Review Runs a parameter outside its contract.
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
  const latestQuery = React.useRef(query)
  latestQuery.current = query
  const pageSizeOptions = PAGE_SIZES.includes(pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, pageSize].sort((left, right) => left - right)
  const load = React.useCallback(async (): Promise<void> => {
    const requestedQuery = query
    try {
      const nextData = await api<{ runs: Run[]; next_cursor: string | null }>(
        `/runs?${requestedQuery}`
      )
      if (latestQuery.current === requestedQuery) {
        setData(nextData)
        setError(undefined)
      }
    } catch (value) {
      if (latestQuery.current === requestedQuery) setError(value)
    }
  }, [query])
  const { refresh, refreshing, lastChecked } = useRefresh(load)
  // An expired session must reach the sign-in form even when the console still has data
  // to show: nothing will update until it is handled, and the refresh banner cannot say so.
  throwIfUnauthorized(auxiliaryError)
  throwIfUnauthorized(error)
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
      <Group
        className="runs-heading"
        justify="space-between"
        align="center"
        mb="lg"
      >
        <Title order={1}>{t('runs')}</Title>
        <Group gap="sm" align="center" wrap="wrap" justify="flex-end">
          <RunJump />
          <RefreshControls
            refresh={refresh}
            refreshing={refreshing}
            lastChecked={lastChecked}
          />
        </Group>
      </Group>
      {blocked.length > 0 && (
        <Alert
          color="orange"
          variant="light"
          mb="md"
          title={t('parkedRunsTitle')}
          icon={<IconAlertTriangle size={ICON_SIZE.lg} />}
          data-testid="parked-runs"
          // A standing queue, not a transient fault: `role="alert"` belongs to the refresh
          // error below, and Mantine's Alert would otherwise claim that role and be the first
          // thing an alert-based assertion sees.
          role="status"
        >
          <Text size="sm">{t('parkedRunsSummary')}</Text>
          <div id="parked-runs-details">
            <Collapse expanded={showParkedDetails}>
              <Text size="sm" mt="xs" mb="xs">
                {t('parkedRunsBody')}
              </Text>
              <Stack gap={4}>
                {blocked.map((block) => (
                  <Text
                    key={block.run_id}
                    size="sm"
                    component={Link}
                    to={`/runs/${encodeURIComponent(block.run_id)}`}
                    c="orange.9"
                  >
                    {/* The axis is shown because the decision differs by axis, and the run id alone
                        leaves the operator guessing which one stopped. */}
                    <Text span size="xs" c="dimmed">
                      {axisLabel(block.axis, t)}
                      {' · '}
                    </Text>
                    <Text span ff="monospace" size="sm">
                      {block.run_id}
                    </Text>
                  </Text>
                ))}
              </Stack>
            </Collapse>
          </div>
          <Button
            variant="subtle"
            color="orange"
            size="compact-xs"
            mt="xs"
            aria-expanded={showParkedDetails}
            aria-controls="parked-runs-details"
            onClick={() => setShowParkedDetails((value) => !value)}
          >
            {showParkedDetails ? t('hideDetails') : t('showDetails')}
          </Button>
        </Alert>
      )}
      {Boolean(error) && (
        <Text role="alert" c="red" mb="md">
          {t('refreshFailed')}
          {failureReason(error, t) && ` ${failureReason(error, t)}`}
        </Text>
      )}
      <Box className="operations-bar" mb="lg">
        {/* Page size lives with the pager below the table, where "how many per page" is asked. */}
        <div className="operations-row">
          <Group aria-label="Run list controls" align="flex-end" gap="md">
            <NativeSelect
              w={120}
              label={t('platform')}
              value={search.get('source_platform') ?? ''}
              onChange={(event) =>
                update('source_platform', event.target.value)
              }
            >
              <option value="">{t('all')}</option>
              <option value="github">{t('platformGithub')}</option>
            </NativeSelect>
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
            <Button
              variant={search.has('range') ? 'light' : 'subtle'}
              leftSection={<IconAdjustmentsHorizontal size={ICON_SIZE.md} />}
              rightSection={
                <IconChevronDown
                  size={14}
                  style={{
                    transform: moreFiltersOpened ? 'rotate(180deg)' : undefined,
                    transition: 'transform 150ms ease'
                  }}
                />
              }
              onClick={() => setMoreFiltersOpened((opened) => !opened)}
              aria-expanded={moreFiltersOpened}
            >
              {t('moreFilters')}
            </Button>
          </Group>
        </div>
        <Collapse expanded={moreFiltersOpened}>
          <Group className="operations-more" mt="md" align="flex-end">
            <NativeSelect
              w={140}
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
        </Collapse>
      </Box>
      {data === undefined ? (
        <LoadingState message={t('loadingRuns')} />
      ) : data.runs.length === 0 ? (
        <EmptyState
          message={t('emptyRuns')}
          icon={
            <IconInbox
              size={40}
              stroke={1.2}
              style={{ color: 'var(--mantine-color-dimmed)' }}
            />
          }
        />
      ) : (
        <>
          <Paper withBorder radius="md" className="table-wrap">
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('run')}</Table.Th>
                  <Table.Th>{t('workflow')}</Table.Th>
                  <Table.Th>{t('platform')}</Table.Th>
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
                            // A hex id reads far better in a monospaced face: proportional
                            // digits make `0`/`O` and `1`/`l` ambiguous at 12px.
                            style={{
                              fontFamily:
                                'var(--mantine-font-family-monospace)',
                              whiteSpace: 'nowrap'
                            }}
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
                      <PlatformMark
                        platform={run.source_platform}
                        githubLabel={t('platformGithub')}
                        gitlabLabel={t('platformGitlab')}
                        unknownLabel={t('platformUnknown')}
                        compactOnNarrow
                      />
                    </Table.Td>
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
                comboboxProps={{ withinPortal: true }}
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
