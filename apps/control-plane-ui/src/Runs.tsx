import React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Box,
  Container,
  Group,
  NativeSelect,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Tooltip
} from '@mantine/core'
import { IconInbox } from '@tabler/icons-react'
import { api, ApiError, type Run } from './api.js'
import { formatDate, useLanguage, useMessages } from './i18n.js'
import { CopyAction, RefreshControls, useRefresh } from './App.js'
import {
  ExecutionStatus,
  PublicationStatus,
  executionStatusLabel,
  runPublicationStatusLabel
} from './status.js'
import { abbreviate, failureReason, formatDuration, lastActivity, workflowLabel } from './format.js'

const RANGE_MINUTES: Record<string, number> = { '1h': 60, '24h': 1_440, '7d': 10_080 }
const PAGE_SIZES: readonly number[] = [10, 20, 50, 100]
/** Mirrors the Control Plane's own default, so an unadorned `/runs` asks for what
 * the server would have returned anyway. */
const DEFAULT_PAGE_SIZE = 50

export function Runs(): React.JSX.Element {
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
      setData(await api<{ runs: Run[]; next_cursor: string | null }>(`/runs?${query}`))
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
    <Container size="lg" py="xl">
      <Title order={1} mb="lg">
        {t('runs')}
      </Title>
      {Boolean(error) && (
        <Text role="alert" c="red" mb="md">
          {t('refreshFailed')}
          {failureReason(error, t) && ` ${failureReason(error, t)}`}
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
              {(['pending', 'publishing', 'published', 'failed', 'skipped'] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {runPublicationStatusLabel(value, t)}
                  </option>
                )
              )}
            </NativeSelect>
            <NativeSelect
              label={t('timeRange')}
              value={search.get('range') ?? ''}
              onChange={(event) => update('range', event.target.value)}
            >
              <option value="">{t('all')}</option>
              <option value="1h">{t('lastHour')}</option>
              <option value="24h">{t('lastDay')}</option>
              <option value="7d">{t('lastWeek')}</option>
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
                      <ExecutionStatus status={run.execution_status} />
                    </Table.Td>
                    <Table.Td>
                      <PublicationStatus status={run.publication_status} />
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={formatDate(lastActivity(run), language)}>
                        <span>
                          {formatDuration(Date.now() - Date.parse(lastActivity(run)), t)} {t('ago')}
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
