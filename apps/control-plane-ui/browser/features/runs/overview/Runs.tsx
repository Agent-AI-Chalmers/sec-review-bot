import type React from 'react'
import { Container, Group, Text, Title } from '@mantine/core'
import { IconInbox } from '@tabler/icons-react'
import { useMessages } from '../../../shared/i18n.js'
import { RefreshControls } from '../../../shared/refresh.js'
import { EmptyState, LoadingState } from '../../../shared/StateMessage.js'
import { ICON_SIZE } from '../../../shared/design.js'
import { failureReason } from '../format.js'
import { ParkedRuns } from './ParkedRuns.js'
import { RunJump } from '../RunJump.js'
import { RunFilters } from './RunFilters.js'
import { RunsTable } from './RunsTable.js'
import { RunsPagination } from './RunsPagination.js'
import { useRunsData } from './useRunsData.js'
import { useRunsLocation } from './useRunsLocation.js'

export function Runs(): React.JSX.Element {
  const t = useMessages()
  const {
    search,
    query,
    pageSize,
    page,
    updateFilter,
    changePageSize,
    openNextPage,
    openPreviousPage
  } = useRunsLocation()
  const {
    data,
    blocked,
    error,
    auxiliaryError,
    refresh,
    refreshing,
    lastChecked
  } = useRunsData(query)
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
        <Group
          className="runs-heading-actions"
          gap="sm"
          align="center"
          wrap="wrap"
          justify="flex-end"
        >
          <RunJump />
          <RefreshControls
            refresh={refresh}
            refreshing={refreshing}
            lastChecked={lastChecked}
          />
        </Group>
      </Group>
      <ParkedRuns blocked={blocked} />
      {Boolean(error) && (
        <Text role="alert" c="red" mb="md">
          {t('refreshFailed')}
          {failureReason(error, t) && ` ${failureReason(error, t)}`}
        </Text>
      )}
      {auxiliaryError !== undefined && (
        <Text role="alert" c="red" mb="md">
          {t('parkedRunsError')}
          {failureReason(auxiliaryError, t) &&
            ` ${failureReason(auxiliaryError, t)}`}
        </Text>
      )}
      <RunFilters search={search} onChange={updateFilter} />
      {data === undefined ? (
        <LoadingState message={t('loadingRuns')} fill />
      ) : data.runs.length === 0 ? (
        <EmptyState
          message={t('emptyRuns')}
          icon={
            <IconInbox
              size={ICON_SIZE.xxl}
              stroke={1.2}
              style={{ color: 'var(--mantine-color-dimmed)' }}
            />
          }
        />
      ) : (
        <>
          <RunsTable runs={data.runs} listSearch={search.toString()} />
          <RunsPagination
            pageSize={pageSize}
            page={page}
            total={totalPages}
            onPageSizeChange={changePageSize}
            onPreviousPage={openPreviousPage}
            onNextPage={() => openNextPage(data.next_cursor)}
          />
        </>
      )}
    </Container>
  )
}
