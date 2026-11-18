import React from 'react'
import { Alert, Button, Container, Tabs, Title } from '@mantine/core'
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
  MemoryTreeVersion
} from './api-types.generated.js'
import { MemoryEditorDialog, MemoryRestoreDialog } from './MemoryDialogs.js'
import { MemoryFilesViewer } from './MemoryFilesViewer.js'
import { MemoryHeader } from './MemoryHeader.js'
import { MemoryObservationList } from './MemoryObservationList.js'
import { MemoryOverview } from './MemoryOverview.js'
import { MemoryVersionDiffViewer } from './MemoryVersionDiff.js'
import { MemoryVersionHistory } from './MemoryVersionHistory.js'
import { useMemoryEditor } from './useMemoryEditor.js'
import { DEFAULT_PAGE_SIZE, useMemoryResources } from './useMemoryResources.js'
import type { PagedResource } from './usePagedResource.js'
import { CursorPagination } from '../../shared/CursorPagination.js'
import { ResourceLoadError } from '../../shared/ResourceLoadError.js'
import { LoadingState } from '../../shared/StateMessage.js'
import { TrajectoryViewer, type TrajectoryTarget } from '../trajectory/TrajectoryViewer.js'

type Version = MemoryTreeVersion
type RestoreRequest = Omit<MemoryTreeRestoreOperation, 'actor'>

function operationId(): string {
  return crypto.randomUUID()
}

export function Memory(): React.JSX.Element {
  const t = useMessages()
  const {
    automation,
    tree,
    graphVersions,
    graphTarget,
    showGraph,
    versionPages,
    observationPages,
    overview,
    overviewRange,
    changeOverviewRange,
    refresh,
    refreshing,
    lastChecked
  } = useMemoryResources()
  const activeVersion = tree.data?.version
  const editor = useMemoryEditor()
  const [restoreVersion, setRestoreVersion] = React.useState<number>()
  const [viewVersion, setViewVersion] = React.useState<number>()
  const [diffVersion, setDiffVersion] = React.useState<Version>()
  const [trajectoryTarget, setTrajectoryTarget] = React.useState<TrajectoryTarget>()
  const [activeTab, setActiveTab] = React.useState<string | null>('overview')
  const [versionView, setVersionView] = React.useState('graph')
  const [highlightedVersion, setHighlightedVersion] = React.useState<number>()
  const [highlightedObservation, setHighlightedObservation] = React.useState<string>()
  const [error, setError] = React.useState('')
  const [editError, setEditError] = React.useState('')
  const [restoreError, setRestoreError] = React.useState('')
  const [queryFailure, setQueryFailure] = React.useState<unknown>()
  const [busy, setBusy] = React.useState(false)

  const revealVersion = (version: number): void => {
    setActiveTab('versions')
    setVersionView('graph')
    // Clearing first lets repeated visits to the same version replay the cue.
    setHighlightedVersion(undefined)
    requestAnimationFrame(() => setHighlightedVersion(version))
    void showGraph(version)
  }

  // A version consumes one learning batch, which the catalog caps at 100, the same
  // as its largest list page; the filtered first page at that size holds the target.
  const revealObservation = (version: number, observationId: string): void => {
    setActiveTab('observations')
    setHighlightedObservation(undefined)
    void observationPages
      .openFirst({ filter: version, limit: MAX_PAGE_SIZE })
      .then(() => setHighlightedObservation(observationId))
  }

  const viewMemoryMaintainerTrajectory = (version: number): void => {
    setTrajectoryTarget({
      title: t('memoryMaintainerTrajectory'),
      contentHref: `/memory/versions/${version}/trajectory/content`,
      downloadHref: `/api/memory/versions/${version}/trajectory`,
      pageHref: `/memory/versions/${version}/trajectory`
    })
  }

  const automationAction = async (action: 'pause' | 'resume'): Promise<void> => {
    if (automation.data === undefined) return
    setBusy(true)
    setError('')
    try {
      const request = {
        operation_id: operationId(),
        expected_version: automation.data.version
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
    if (activeVersion === undefined) return
    setEditError('')
    try {
      await editor.begin(activeVersion)
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
          ? t('memoryVersionConflict')
          : t('memoryEditFailed')
      )
    } finally {
      setBusy(false)
    }
  }
  const restore = async (): Promise<void> => {
    if (restoreVersion === undefined || activeVersion === undefined) return
    setBusy(true)
    setRestoreError('')
    try {
      const request = {
        operation_id: operationId(),
        expected_active_version: activeVersion,
        restored_version: restoreVersion
      } satisfies RestoreRequest
      await apiPost('/memory/restore', request)
      setRestoreVersion(undefined)
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
      graphVersions.error,
      versionPages.resource.error,
      observationPages.resource.error,
      overview.error
    ].find(isUnauthorizedApiError)
  throwIfUnauthorized(queryError)

  // A failure the boundary should handle is not also rendered as a per-panel message.
  const failureText = (failure: unknown, message: Message): string =>
    failure === undefined || isUnauthorizedApiError(failure) ? '' : t(message)
  const automationError = failureText(automation.error, 'memoryAutomationLoadFailed')
  const treeError = failureText(tree.error, 'memoryTreeLoadFailed')
  const graphVersionsError = failureText(graphVersions.error, 'memoryVersionsLoadFailed')
  const versionPageError = failureText(versionPages.resource.error, 'memoryVersionsLoadFailed')
  const observationsError = failureText(
    observationPages.resource.error,
    'memoryObservationsLoadFailed'
  )
  const overviewError = failureText(overview.error, 'memoryOverviewLoadFailed')

  const unavailable =
    Boolean(automationError && treeError && overviewError) &&
    automation.data === undefined &&
    tree.data === undefined &&
    overview.data === undefined

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
        activeVersion={activeVersion}
        busy={busy}
        automationLoading={automation.loading}
        treeLoading={tree.loading}
        automationError={unavailable ? '' : automationError}
        treeError={unavailable ? '' : treeError}
        refresh={refresh}
        refreshing={refreshing}
        lastChecked={lastChecked}
        onToggleAutomation={() => {
          if (automation.data)
            void automationAction(automation.data.state === 'enabled' ? 'pause' : 'resume')
        }}
        onEdit={() => void beginEdit()}
      />
      {unavailable ? (
        <ResourceLoadError
          fill
          title={t('memoryUnavailable')}
          message={t('memoryUnavailableHelp')}
          actions={
            <Button variant="default" loading={refreshing} onClick={() => void refresh()}>
              {t('retry')}
            </Button>
          }
        />
      ) : (
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="overview">{t('memoryOverview')}</Tabs.Tab>
            <Tabs.Tab value="versions">{t('memoryVersions')}</Tabs.Tab>
            <Tabs.Tab value="observations">{t('memoryObservations')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="overview" pt="md">
            {overviewError && (
              <ResourceLoadError
                fill
                title={overviewError}
                message={t('resourceRetryHelp')}
                actions={
                  <Button variant="default" loading={refreshing} onClick={() => void refresh()}>
                    {t('retry')}
                  </Button>
                }
              />
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
          <Tabs.Panel value="versions" pt="md">
            <MemoryVersionHistory
              graphVersions={graphVersions.data?.versions ?? []}
              graphTarget={graphTarget}
              onShowLatest={() => {
                setHighlightedVersion(undefined)
                void showGraph()
              }}
              graphLoading={graphVersions.loading}
              graphError={graphVersionsError}
              listVersions={versionPages.resource.data?.page.versions ?? []}
              listLoading={versionPages.resource.loading}
              listError={versionPageError}
              pagination={pagination(
                versionPages,
                versionPages.resource.data?.page.next_before_version
              )}
              activeVersion={activeVersion}
              view={versionView}
              highlightedVersion={highlightedVersion}
              onViewChange={setVersionView}
              onViewFiles={setViewVersion}
              onViewTrajectory={viewMemoryMaintainerTrajectory}
              onRevealObservation={revealObservation}
              onCompare={setDiffVersion}
              onSetCurrent={(version) => {
                setRestoreError('')
                setRestoreVersion(version)
              }}
              onHighlightEnd={() => setHighlightedVersion(undefined)}
            />
          </Tabs.Panel>
          <Tabs.Panel value="observations" pt="md">
            <MemoryObservationList
              observations={observationPages.resource.data?.page.observations ?? []}
              loading={observationPages.resource.loading}
              error={observationsError}
              pagination={pagination(
                observationPages,
                observationPages.resource.data?.page.next_cursor
              )}
              versionFilter={observationPages.query.filter}
              onClearVersionFilter={() => {
                setHighlightedObservation(undefined)
                void observationPages.openFirst({
                  filter: undefined,
                  limit: DEFAULT_PAGE_SIZE
                })
              }}
              highlightedObservation={highlightedObservation}
              onHighlightEnd={() => setHighlightedObservation(undefined)}
              onRevealVersion={revealVersion}
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
      )}
      <MemoryFilesViewer version={viewVersion} onClose={() => setViewVersion(undefined)} />
      <MemoryVersionDiffViewer target={diffVersion} onClose={() => setDiffVersion(undefined)} />
      <TrajectoryViewer target={trajectoryTarget} onClose={() => setTrajectoryTarget(undefined)} />
      <MemoryRestoreDialog
        error={restoreError}
        version={restoreVersion}
        busy={busy}
        onClose={() => setRestoreVersion(undefined)}
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
