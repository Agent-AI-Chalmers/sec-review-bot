import React from 'react'
import { Alert, Container, Tabs, Title } from '@mantine/core'
import {
  api,
  apiPost,
  ApiError,
  isUnauthorizedApiError,
  throwIfUnauthorized
} from '../../shared/api-client.js'
import { useMessages } from '../../shared/i18n.js'
import type { components } from './api-types.generated.js'
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
import {
  TranscriptViewer,
  type TranscriptTarget
} from '../transcript/TranscriptViewer.js'

type Control = components['schemas']['MaintenanceControl']
type Revision = components['schemas']['MemoryTreeRevision']
type RevisionPage = components['schemas']['MemoryTreeRevisionList']
type ObservationPage = components['schemas']['ObservationList']
type MemoryTree = components['schemas']['MemoryTree']
type MaintenanceControlRequest = Omit<
  components['schemas']['MaintenanceControlOperation'],
  'actor'
>
type RestoreRequest = Omit<
  components['schemas']['MemoryTreeRestoreOperation'],
  'actor'
>
function operationId(): string {
  return crypto.randomUUID()
}

export function Memory(): React.JSX.Element {
  const t = useMessages()
  const [control, setControl] = React.useState<Control>()
  const [revisions, setRevisions] = React.useState<Revision[]>([])
  const [observations, setObservations] = React.useState<
    ObservationPage['observations']
  >([])
  const [overview, setOverview] = React.useState<CatalogOverview>()
  const [overviewRange, setOverviewRange] = React.useState<OverviewRange>('30d')
  const overviewRangeRef = React.useRef<OverviewRange>('30d')
  const [activeRevision, setActiveRevision] = React.useState<number>()
  const [files, setFiles] = React.useState<Record<string, string>>({})
  const [initialFiles, setInitialFiles] = React.useState<
    Record<string, string>
  >({})
  const [editOpen, setEditOpen] = React.useState(false)
  const [restoreRevision, setRestoreRevision] = React.useState<number>()
  const [viewRevision, setViewRevision] = React.useState<number>()
  const [diffRevision, setDiffRevision] = React.useState<Revision>()
  const [transcriptTarget, setTranscriptTarget] =
    React.useState<TranscriptTarget>()
  const [activeTab, setActiveTab] = React.useState<string | null>('overview')
  const [revisionView, setRevisionView] = React.useState('graph')
  const [highlightedRevision, setHighlightedRevision] = React.useState<number>()
  const [error, setError] = React.useState('')
  const [queryError, setQueryError] = React.useState<unknown>()
  const [controlError, setControlError] = React.useState('')
  const [treeError, setTreeError] = React.useState('')
  const [revisionsError, setRevisionsError] = React.useState('')
  const [observationsError, setObservationsError] = React.useState('')
  const [overviewError, setOverviewError] = React.useState('')
  const [controlLoading, setControlLoading] = React.useState(true)
  const [treeLoading, setTreeLoading] = React.useState(true)
  const [revisionsLoading, setRevisionsLoading] = React.useState(true)
  const [observationsLoading, setObservationsLoading] = React.useState(true)
  const [overviewLoading, setOverviewLoading] = React.useState(true)
  const overviewRequest = React.useRef(0)
  const [busy, setBusy] = React.useState(false)
  const loadControl = React.useCallback(async (): Promise<void> => {
    setControlLoading(true)
    try {
      const nextControl = await api<Control>('/memory/maintenance-control')
      setControl(nextControl)
      setControlError('')
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
      else setControlError(t('memoryControlLoadFailed'))
    } finally {
      setControlLoading(false)
    }
  }, [t])

  const loadTree = React.useCallback(async (): Promise<void> => {
    setTreeLoading(true)
    try {
      const tree = await api<MemoryTree>('/memory/tree')
      setActiveRevision(tree.revision)
      setTreeError('')
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
      else setTreeError(t('memoryTreeLoadFailed'))
    } finally {
      setTreeLoading(false)
    }
  }, [t])

  const loadRevisions = React.useCallback(async (): Promise<void> => {
    setRevisionsLoading(true)
    try {
      const revisionPage = await api<RevisionPage>('/memory/revisions?limit=50')
      setRevisions(revisionPage.revisions)
      setRevisionsError('')
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
      else setRevisionsError(t('memoryRevisionsLoadFailed'))
    } finally {
      setRevisionsLoading(false)
    }
  }, [t])

  const loadObservations = React.useCallback(async (): Promise<void> => {
    setObservationsLoading(true)
    try {
      const observationPage = await api<ObservationPage>(
        '/memory/observations?limit=50'
      )
      setObservations(observationPage.observations)
      setObservationsError('')
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
      else setObservationsError(t('memoryObservationsLoadFailed'))
    } finally {
      setObservationsLoading(false)
    }
  }, [t])

  const loadOverview = React.useCallback(
    async (range: OverviewRange): Promise<void> => {
      const request = ++overviewRequest.current
      setOverviewLoading(true)
      try {
        const nextOverview = await api<CatalogOverview>(
          `/memory/overview?range=${range}`
        )
        if (
          overviewRequest.current === request &&
          overviewRangeRef.current === range
        ) {
          setOverview(nextOverview)
          setOverviewError('')
        }
      } catch (failure) {
        if (
          overviewRequest.current === request &&
          overviewRangeRef.current === range
        ) {
          if (isUnauthorizedApiError(failure)) setQueryError(failure)
          else setOverviewError(t('memoryOverviewLoadFailed'))
        }
      } finally {
        if (
          overviewRequest.current === request &&
          overviewRangeRef.current === range
        )
          setOverviewLoading(false)
      }
    },
    [t]
  )

  const load = React.useCallback(async (): Promise<void> => {
    const requestedOverviewRange = overviewRangeRef.current
    await Promise.all([
      loadControl(),
      loadTree(),
      loadRevisions(),
      loadObservations(),
      loadOverview(requestedOverviewRange)
    ])
  }, [loadControl, loadObservations, loadOverview, loadRevisions, loadTree])
  const { refresh, refreshing, lastChecked } = useRefresh(load)

  const changeOverviewRange = async (range: OverviewRange): Promise<void> => {
    setOverviewRange(range)
    overviewRangeRef.current = range
    await loadOverview(range)
  }

  const revealRevision = (revision: number): void => {
    setActiveTab('revisions')
    setRevisionView('graph')
    // Clearing first lets repeated visits to the same revision replay the cue.
    setHighlightedRevision(undefined)
    requestAnimationFrame(() => setHighlightedRevision(revision))
  }

  const viewMaintenanceProcess = (revision: number): void => {
    setTranscriptTarget({
      title: t('maintenanceProcess'),
      contentHref: `/memory/revisions/${revision}/transcript/content`,
      downloadHref: `/api/memory/revisions/${revision}/transcript`,
      pageHref: `/memory/revisions/${revision}/transcript`
    })
  }

  const controlAction = async (action: 'pause' | 'resume'): Promise<void> => {
    if (!control) return
    setBusy(true)
    setError('')
    try {
      const request = {
        operation_id: operationId(),
        expected_generation: control.generation
      } satisfies MaintenanceControlRequest
      await apiPost(`/memory/${action}`, request)
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
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
    if (activeRevision === 0) {
      const initial = { 'MEMORY.md': '# Security Review Experience Memory\n' }
      setFiles(initial)
      setInitialFiles(initial)
      setEditOpen(true)
      return
    }
    try {
      const content = await api<{ files: Record<string, string> }>(
        `/memory/revisions/${activeRevision}/content`
      )
      setFiles(content.files)
      setInitialFiles(content.files)
      setEditOpen(true)
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
      else setError(t('memoryLoadFailed'))
    }
  }
  const commitEdit = async (): Promise<void> => {
    if (activeRevision === undefined) return
    setBusy(true)
    setError('')
    try {
      await apiPost('/memory/edit', {
        operation_id: operationId(),
        expected_active_revision: activeRevision,
        files
      })
      setEditOpen(false)
      setInitialFiles(files)
      await refresh()
    } catch (failure) {
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
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
      if (isUnauthorizedApiError(failure)) setQueryError(failure)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t('memoryRestoreConflict')
          : t('memoryRestoreFailed')
      )
    } finally {
      setBusy(false)
    }
  }

  throwIfUnauthorized(queryError)
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
        control={control}
        activeRevision={activeRevision}
        busy={busy}
        controlLoading={controlLoading}
        treeLoading={treeLoading}
        controlError={controlError}
        treeError={treeError}
        refresh={refresh}
        refreshing={refreshing}
        lastChecked={lastChecked}
        onToggleMaintenance={() => {
          if (control)
            void controlAction(control.state === 'enabled' ? 'pause' : 'resume')
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
          {overviewLoading && !overview && <p>{t('loading')}</p>}
          {overview && (
            <MemoryOverview
              overview={overview}
              range={overviewRange}
              onRangeChange={(range) => void changeOverviewRange(range)}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="revisions" pt="md">
          <MemoryRevisionHistory
            revisions={revisions}
            activeRevision={activeRevision}
            loading={revisionsLoading}
            error={revisionsError}
            view={revisionView}
            highlightedRevision={highlightedRevision}
            onViewChange={setRevisionView}
            onViewFiles={setViewRevision}
            onViewProcess={viewMaintenanceProcess}
            onCompare={setDiffRevision}
            onSetCurrent={setRestoreRevision}
            onHighlightEnd={() => setHighlightedRevision(undefined)}
          />
        </Tabs.Panel>
        <Tabs.Panel value="observations" pt="md">
          <MemoryObservationList
            observations={observations}
            loading={observationsLoading}
            error={observationsError}
            onRevealRevision={revealRevision}
            onViewProcess={(item) =>
              setTranscriptTarget({
                title: t('extractionProcess'),
                contentHref: `/memory/extractions/${encodeURIComponent(item.extraction_id)}/transcript/content`,
                downloadHref: `/api/memory/extractions/${encodeURIComponent(item.extraction_id)}/transcript`,
                pageHref: `/memory/extractions/${encodeURIComponent(item.extraction_id)}/transcript`
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
      <TranscriptViewer
        target={transcriptTarget}
        onClose={() => setTranscriptTarget(undefined)}
      />
      <MemoryRestoreDialog
        revision={restoreRevision}
        busy={busy}
        onClose={() => setRestoreRevision(undefined)}
        onConfirm={() => void restore()}
      />
      <MemoryEditorDialog
        opened={editOpen}
        files={files}
        initialFiles={initialFiles}
        busy={busy}
        onFilesChange={setFiles}
        onClose={() => setEditOpen(false)}
        onCommit={() => void commitEdit()}
      />
    </Container>
  )
}
