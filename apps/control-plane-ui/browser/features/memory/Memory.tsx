import React from 'react'
import { Alert, Container, Tabs, Title } from '@mantine/core'
import {
  apiPost,
  ApiError,
  isUnauthorizedApiError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { useMessages, type Message } from '../../shared/i18n.js'
import type {
  MemoryTreeAutomationOperation,
  MemoryTreeRestoreOperation,
  MemoryTreeRevision
} from './api-types.generated.js'
import { MemoryEditorDialog, MemoryRestoreDialog } from './MemoryDialogs.js'
import { MemoryFilesViewer } from './MemoryFilesViewer.js'
import { MemoryHeader } from './MemoryHeader.js'
import { MemoryObservationList } from './MemoryObservationList.js'
import { MemoryOverview } from './MemoryOverview.js'
import { MemoryRevisionDiffViewer } from './MemoryRevisionDiff.js'
import { MemoryRevisionHistory } from './MemoryRevisionHistory.js'
import { useMemoryEditor } from './useMemoryEditor.js'
import { DEFAULT_PAGE_SIZE, useMemoryResources } from './useMemoryResources.js'
import type { PagedResource } from './usePagedResource.js'
import { CursorPagination } from '../../shared/CursorPagination.js'
import { LoadingState } from '../../shared/StateMessage.js'
import {
  TrajectoryViewer,
  type TrajectoryTarget
} from '../trajectory/TrajectoryViewer.js'

type Revision = MemoryTreeRevision
type RestoreRequest = Omit<MemoryTreeRestoreOperation, 'actor'>

function operationId(): string {
  return crypto.randomUUID()
}

export function Memory(): React.JSX.Element {
  const t = useMessages()
  const {
    automation,
    tree,
    graphRevisions,
    graphTarget,
    showGraph,
    revisionPages,
    observationPages,
    overview,
    overviewRange,
    changeOverviewRange,
    refresh,
    refreshing,
    lastChecked
  } = useMemoryResources()
  const activeRevision = tree.data?.revision
  const editor = useMemoryEditor()
  const [restoreRevision, setRestoreRevision] = React.useState<number>()
  const [viewRevision, setViewRevision] = React.useState<number>()
  const [diffRevision, setDiffRevision] = React.useState<Revision>()
  const [trajectoryTarget, setTrajectoryTarget] =
    React.useState<TrajectoryTarget>()
  const [activeTab, setActiveTab] = React.useState<string | null>('overview')
  const [revisionView, setRevisionView] = React.useState('graph')
  const [highlightedRevision, setHighlightedRevision] = React.useState<number>()
  const [highlightedObservation, setHighlightedObservation] =
    React.useState<string>()
  const [error, setError] = React.useState('')
  const [editError, setEditError] = React.useState('')
  const [restoreError, setRestoreError] = React.useState('')
  const [queryFailure, setQueryFailure] = React.useState<unknown>()
  const [busy, setBusy] = React.useState(false)

  const revealRevision = (revision: number): void => {
    setActiveTab('revisions')
    setRevisionView('graph')
    // Clearing first lets repeated visits to the same revision replay the cue.
    setHighlightedRevision(undefined)
    requestAnimationFrame(() => setHighlightedRevision(revision))
    void showGraph(revision)
  }

  // A revision consumes one learning batch, which the catalog caps at 100, the same
  // as its largest list page; the filtered first page at that size holds the target.
  const revealObservation = (revision: number, observationId: string): void => {
    setActiveTab('observations')
    setHighlightedObservation(undefined)
    void observationPages
      .openFirst({ filter: revision, limit: MAX_PAGE_SIZE })
      .then(() => setHighlightedObservation(observationId))
  }

  const viewMemoryMaintainerTrajectory = (revision: number): void => {
    setTrajectoryTarget({
      title: t('memoryMaintainerTrajectory'),
      contentHref: `/memory/revisions/${revision}/trajectory/content`,
      downloadHref: `/api/memory/revisions/${revision}/trajectory`,
      pageHref: `/memory/revisions/${revision}/trajectory`
    })
  }

  const automationAction = async (
    action: 'pause' | 'resume'
  ): Promise<void> => {
    if (automation.data === undefined) return
    setBusy(true)
    setError('')
    try {
      const request = {
        operation_id: operationId(),
        expected_generation: automation.data.generation
      } satisfies MemoryTreeAutomationOperation
      await apiPost(`/memory/tree/automation/${action}`, request)
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t('memoryAutomationConflict')
          : t('memoryAutomationFailed')
      )
    } finally {
      setBusy(false)
    }
  }
  const beginEdit = async (): Promise<void> => {
    if (activeRevision === undefined) return
    setEditError('')
    try {
      await editor.begin(activeRevision)
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      else setError(t('memoryLoadFailed'))
    }
  }
  const commitEdit = async (): Promise<void> => {
    if (editor.session === undefined) return
    setBusy(true)
    setEditError('')
    try {
      await editor.commit()
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      setEditError(
        failure instanceof ApiError && failure.status === 409
          ? t('memoryRevisionConflict')
          : t('memoryEditFailed')
      )
    } finally {
      setBusy(false)
    }
  }
  const restore = async (): Promise<void> => {
    if (restoreRevision === undefined || activeRevision === undefined) return
    setBusy(true)
    setRestoreError('')
    try {
      const request = {
        operation_id: operationId(),
        expected_active_revision: activeRevision,
        restored_revision: restoreRevision
      } satisfies RestoreRequest
      await apiPost('/memory/restore', request)
      setRestoreRevision(undefined)
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      setRestoreError(
        failure instanceof ApiError && failure.status === 409
          ? t('memoryRestoreConflict')
          : t('memoryRestoreFailed')
      )
    } finally {
      setBusy(false)
    }
  }

  // A session that expired is the app's problem, not this tab's: render throws it to the
  // error boundary so every surface agrees on what an expired console session looks like.
  const queryError =
    queryFailure ??
    [
      automation.error,
      tree.error,
      graphRevisions.error,
      revisionPages.resource.error,
      observationPages.resource.error,
      overview.error
    ].find(isUnauthorizedApiError)
  throwIfUnauthorized(queryError)

  // A failure the boundary should handle is not also rendered as a per-panel message.
  const failureText = (failure: unknown, message: Message): string =>
    failure === undefined || isUnauthorizedApiError(failure) ? '' : t(message)
  const automationError = failureText(
    automation.error,
    'memoryAutomationLoadFailed'
  )
  const treeError = failureText(tree.error, 'memoryTreeLoadFailed')
  const graphRevisionsError = failureText(
    graphRevisions.error,
    'memoryRevisionsLoadFailed'
  )
  const revisionPageError = failureText(
    revisionPages.resource.error,
    'memoryRevisionsLoadFailed'
  )
  const observationsError = failureText(
    observationPages.resource.error,
    'memoryObservationsLoadFailed'
  )
  const overviewError = failureText(overview.error, 'memoryOverviewLoadFailed')

  return (
    <Container size="lg" py="xl">
      <Title order={1} mb="lg">
        {t('memory')}
      </Title>
      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}
      <MemoryHeader
        automation={automation.data}
        activeRevision={activeRevision}
        busy={busy}
        automationLoading={automation.loading}
        treeLoading={tree.loading}
        automationError={automationError}
        treeError={treeError}
        refresh={refresh}
        refreshing={refreshing}
        lastChecked={lastChecked}
        onToggleAutomation={() => {
          if (automation.data)
            void automationAction(
              automation.data.state === 'enabled' ? 'pause' : 'resume'
            )
        }}
        onEdit={() => void beginEdit()}
      />
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List>
          <Tabs.Tab value="overview">{t('memoryOverview')}</Tabs.Tab>
          <Tabs.Tab value="revisions">{t('memoryRevisions')}</Tabs.Tab>
          <Tabs.Tab value="observations">{t('memoryObservations')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          {overviewError && (
            <Alert color="red" mb="md">
              {overviewError}
            </Alert>
          )}
          {overview.loading && overview.data === undefined && (
            <LoadingState message={t('loading')} />
          )}
          {overview.data && (
            <MemoryOverview
              overview={overview.data}
              range={overviewRange}
              onRangeChange={(range) => void changeOverviewRange(range)}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="revisions" pt="md">
          <MemoryRevisionHistory
            graphRevisions={graphRevisions.data?.revisions ?? []}
            graphTarget={graphTarget}
            onShowLatest={() => {
              setHighlightedRevision(undefined)
              void showGraph()
            }}
            graphLoading={graphRevisions.loading}
            graphError={graphRevisionsError}
            listRevisions={revisionPages.resource.data?.page.revisions ?? []}
            listLoading={revisionPages.resource.loading}
            listError={revisionPageError}
            pagination={pagination(
              revisionPages,
              revisionPages.resource.data?.page.next_before_revision
            )}
            activeRevision={activeRevision}
            view={revisionView}
            highlightedRevision={highlightedRevision}
            onViewChange={setRevisionView}
            onViewFiles={setViewRevision}
            onViewTrajectory={viewMemoryMaintainerTrajectory}
            onRevealObservation={revealObservation}
            onCompare={setDiffRevision}
            onSetCurrent={(revision) => {
              setRestoreError('')
              setRestoreRevision(revision)
            }}
            onHighlightEnd={() => setHighlightedRevision(undefined)}
          />
        </Tabs.Panel>
        <Tabs.Panel value="observations" pt="md">
          <MemoryObservationList
            observations={
              observationPages.resource.data?.page.observations ?? []
            }
            loading={observationPages.resource.loading}
            error={observationsError}
            pagination={pagination(
              observationPages,
              observationPages.resource.data?.page.next_cursor
            )}
            revisionFilter={observationPages.query.filter}
            onClearRevisionFilter={() => {
              setHighlightedObservation(undefined)
              void observationPages.openFirst({
                filter: undefined,
                limit: DEFAULT_PAGE_SIZE
              })
            }}
            highlightedObservation={highlightedObservation}
            onHighlightEnd={() => setHighlightedObservation(undefined)}
            onRevealRevision={revealRevision}
            onViewTrajectory={(item) =>
              setTrajectoryTarget({
                title: t('memoryExtractorTrajectory'),
                contentHref: `/memory/extractions/${encodeURIComponent(item.extraction_id)}/trajectory/content`,
                downloadHref: `/api/memory/extractions/${encodeURIComponent(item.extraction_id)}/trajectory`,
                pageHref: `/memory/extractions/${encodeURIComponent(item.extraction_id)}/trajectory`
              })
            }
          />
        </Tabs.Panel>
      </Tabs>
      <MemoryFilesViewer
        revision={viewRevision}
        onClose={() => setViewRevision(undefined)}
      />
      <MemoryRevisionDiffViewer
        target={diffRevision}
        onClose={() => setDiffRevision(undefined)}
      />
      <TrajectoryViewer
        target={trajectoryTarget}
        onClose={() => setTrajectoryTarget(undefined)}
      />
      <MemoryRestoreDialog
        error={restoreError}
        revision={restoreRevision}
        busy={busy}
        onClose={() => setRestoreRevision(undefined)}
        onConfirm={() => void restore()}
      />
      {editor.session !== undefined && (
        <MemoryEditorDialog
          error={editError}
          files={editor.session.files}
          initialFiles={editor.session.initialFiles}
          busy={busy}
          onFilesChange={editor.changeFiles}
          onClose={editor.close}
          onCommit={() => void commitEdit()}
        />
      )}
    </Container>
  )
}

const MAX_PAGE_SIZE = 100

/** Pager props for one paged catalog list. */
function pagination<Filter, Cursor, Page>(
  paged: PagedResource<Filter, Cursor, Page>,
  next: Cursor | null | undefined
): React.ComponentProps<typeof CursorPagination> {
  return {
    pageSize: paged.query.limit,
    page: paged.pageNumber,
    total: next == null ? paged.pageNumber : paged.pageNumber + 1,
    onPageSizeChange: (value) => void paged.openFirst({ limit: Number(value) }),
    onPreviousPage: () => void paged.openPrevious(),
    onNextPage: (): void => {
      if (next != null) void paged.openNext(next)
    }
  }
}
