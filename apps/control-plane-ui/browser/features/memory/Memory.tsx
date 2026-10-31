import React from 'react'
import { Alert, Container, Tabs, Title } from '@mantine/core'
import {
  api,
  apiPost,
  ApiError,
  isUnauthorizedApiError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { useMessages, type Message } from '../../shared/i18n.js'
import { useResource } from '../../shared/resource.js'
import type {
  MaintenanceControl,
  MaintenanceControlOperation,
  MemoryTree,
  MemoryTreeRestoreOperation,
  MemoryTreeRevision,
  MemoryTreeRevisionList,
  ObservationList
} from './api-types.generated.js'
import { MemoryEditorDialog, MemoryRestoreDialog } from './MemoryDialogs.js'
import { MemoryFilesViewer } from './MemoryFilesViewer.js'
import { MemoryHeader } from './MemoryHeader.js'
import { MemoryObservationList } from './MemoryObservationList.js'
import {
  MemoryOverview,
  type CatalogOverview,
  type OverviewRange
} from './MemoryOverview.js'
import { MemoryRevisionDiffViewer } from './MemoryRevisionDiff.js'
import { MemoryRevisionHistory } from './MemoryRevisionHistory.js'
import { useRefresh } from '../../shared/refresh.js'
import { LoadingState } from '../../shared/StateMessage.js'
import {
  TrajectoryViewer,
  type TrajectoryTarget
} from '../trajectory/TrajectoryViewer.js'

type Control = MaintenanceControl
type Revision = MemoryTreeRevision
type RevisionPage = MemoryTreeRevisionList
type ObservationPage = ObservationList
type MaintenanceControlRequest = Omit<MaintenanceControlOperation, 'actor'>
type RestoreRequest = Omit<MemoryTreeRestoreOperation, 'actor'>
function operationId(): string {
  return crypto.randomUUID()
}

interface MemoryEditSession {
  baseRevision: number
  initialFiles: Record<string, string>
  files: Record<string, string>
  attempt?: { content: string; operationId: string }
}

export function Memory(): React.JSX.Element {
  const t = useMessages()
  // The selected range lives in a ref as well as in state: a reload has to read the range
  // the reader picked, not the one this render closed over.
  const overviewRangeRef = React.useRef<OverviewRange>('30d')
  const [overviewRange, setOverviewRange] = React.useState<OverviewRange>('30d')
  const control = useResource((signal) =>
    api<Control>('/memory/maintenance-control', { signal })
  )
  const tree = useResource((signal) =>
    api<MemoryTree>('/memory/tree', { signal })
  )
  const revisions = useResource((signal) =>
    api<RevisionPage>('/memory/revisions?limit=50', { signal })
  )
  const observations = useResource((signal) =>
    api<ObservationPage>('/memory/observations?limit=50', { signal })
  )
  const overview = useResource((signal) =>
    api<CatalogOverview>(`/memory/overview?range=${overviewRangeRef.current}`, {
      signal
    })
  )
  const activeRevision = tree.data?.revision
  const [editSession, setEditSession] = React.useState<MemoryEditSession>()
  const [restoreRevision, setRestoreRevision] = React.useState<number>()
  const [viewRevision, setViewRevision] = React.useState<number>()
  const [diffRevision, setDiffRevision] = React.useState<Revision>()
  const [trajectoryTarget, setTrajectoryTarget] =
    React.useState<TrajectoryTarget>()
  const [activeTab, setActiveTab] = React.useState<string | null>('overview')
  const [revisionView, setRevisionView] = React.useState('graph')
  const [highlightedRevision, setHighlightedRevision] = React.useState<number>()
  const [error, setError] = React.useState('')
  const [queryFailure, setQueryFailure] = React.useState<unknown>()
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    await Promise.all([
      control.reload(),
      tree.reload(),
      revisions.reload(),
      observations.reload(),
      overview.reload()
    ])
  }, [
    control.reload,
    observations.reload,
    overview.reload,
    revisions.reload,
    tree.reload
  ])
  const { refresh, refreshing, lastChecked } = useRefresh(load)

  const changeOverviewRange = async (range: OverviewRange): Promise<void> => {
    setOverviewRange(range)
    overviewRangeRef.current = range
    await overview.reload()
  }

  const revealRevision = (revision: number): void => {
    setActiveTab('revisions')
    setRevisionView('graph')
    // Clearing first lets repeated visits to the same revision replay the cue.
    setHighlightedRevision(undefined)
    requestAnimationFrame(() => setHighlightedRevision(revision))
  }

  const viewMemoryMaintainerTrajectory = (revision: number): void => {
    setTrajectoryTarget({
      title: t('memoryMaintainerTrajectory'),
      contentHref: `/memory/revisions/${revision}/trajectory/content`,
      downloadHref: `/api/memory/revisions/${revision}/trajectory`,
      pageHref: `/memory/revisions/${revision}/trajectory`
    })
  }

  const controlAction = async (action: 'pause' | 'resume'): Promise<void> => {
    if (control.data === undefined) return
    setBusy(true)
    setError('')
    try {
      const request = {
        operation_id: operationId(),
        expected_generation: control.data.generation
      } satisfies MaintenanceControlRequest
      await apiPost(`/memory/${action}`, request)
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t('memoryControlConflict')
          : t('memoryControlFailed')
      )
    } finally {
      setBusy(false)
    }
  }
  const beginEdit = async (): Promise<void> => {
    if (activeRevision === undefined) return
    // Capture before loading: catalog refreshes cannot change this edit's base.
    const baseRevision = activeRevision
    try {
      const files =
        baseRevision === 0
          ? { 'MEMORY.md': '# Security Review Experience Memory\n' }
          : (
              await api<{ files: Record<string, string> }>(
                `/memory/revisions/${baseRevision}/content`
              )
            ).files
      setEditSession({ baseRevision, files, initialFiles: files })
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      else setError(t('memoryLoadFailed'))
    }
  }
  const commitEdit = async (): Promise<void> => {
    if (editSession === undefined) return
    setBusy(true)
    setError('')
    try {
      const content = JSON.stringify(
        Object.entries(editSession.files).sort(([a], [b]) => a.localeCompare(b))
      )
      const attempt =
        editSession.attempt?.content === content
          ? editSession.attempt
          : { content, operationId: operationId() }
      setEditSession({ ...editSession, attempt })
      await apiPost('/memory/edit', {
        operation_id: attempt.operationId,
        expected_active_revision: editSession.baseRevision,
        files: editSession.files
      })
      setEditSession(undefined)
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryFailure(failure)
      setError(
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
    setError('')
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
      setError(
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
      control.error,
      tree.error,
      revisions.error,
      observations.error,
      overview.error
    ].find(isUnauthorizedApiError)
  throwIfUnauthorized(queryError)

  // A failure the boundary should handle is not also rendered as a per-panel message.
  const failureText = (failure: unknown, message: Message): string =>
    failure === undefined || isUnauthorizedApiError(failure) ? '' : t(message)
  const controlError = failureText(control.error, 'memoryControlLoadFailed')
  const treeError = failureText(tree.error, 'memoryTreeLoadFailed')
  const revisionsError = failureText(
    revisions.error,
    'memoryRevisionsLoadFailed'
  )
  const observationsError = failureText(
    observations.error,
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
        control={control.data}
        activeRevision={activeRevision}
        busy={busy}
        controlLoading={control.loading}
        treeLoading={tree.loading}
        controlError={controlError}
        treeError={treeError}
        refresh={refresh}
        refreshing={refreshing}
        lastChecked={lastChecked}
        onToggleMaintenance={() => {
          if (control.data)
            void controlAction(
              control.data.state === 'enabled' ? 'pause' : 'resume'
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
            revisions={revisions.data?.revisions ?? []}
            activeRevision={activeRevision}
            loading={revisions.loading}
            error={revisionsError}
            view={revisionView}
            highlightedRevision={highlightedRevision}
            onViewChange={setRevisionView}
            onViewFiles={setViewRevision}
            onViewTrajectory={viewMemoryMaintainerTrajectory}
            onCompare={setDiffRevision}
            onSetCurrent={setRestoreRevision}
            onHighlightEnd={() => setHighlightedRevision(undefined)}
          />
        </Tabs.Panel>
        <Tabs.Panel value="observations" pt="md">
          <MemoryObservationList
            observations={observations.data?.observations ?? []}
            loading={observations.loading}
            error={observationsError}
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
        revision={restoreRevision}
        busy={busy}
        onClose={() => setRestoreRevision(undefined)}
        onConfirm={() => void restore()}
      />
      {editSession !== undefined && (
        <MemoryEditorDialog
          files={editSession.files}
          initialFiles={editSession.initialFiles}
          busy={busy}
          onFilesChange={(files) =>
            setEditSession((session) =>
              session === undefined ? undefined : { ...session, files }
            )
          }
          onClose={() => setEditSession(undefined)}
          onCommit={() => void commitEdit()}
        />
      )}
    </Container>
  )
}
