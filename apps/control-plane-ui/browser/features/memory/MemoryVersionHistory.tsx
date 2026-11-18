import React from 'react'
import { Alert, Button, Group, SegmentedControl, Table } from '@mantine/core'
import { IconArrowsDiff, IconEye, IconHistory } from '@tabler/icons-react'

import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import { EmptyState, LoadingState } from '../../shared/StateMessage.js'
import type { MemoryTreeVersion } from './api-types.generated.js'
import { CursorPagination } from '../../shared/CursorPagination.js'
import { GRAPH_VERSION_WINDOW } from './useMemoryResources.js'
import { MaintenanceReportButton } from './MaintenanceReport.js'
import { VersionGraph } from './VersionGraph.js'
import { ICON_SIZE } from '../../shared/design.js'

type Version = MemoryTreeVersion

export function MemoryVersionHistory({
  graphVersions,
  graphLoading,
  graphError,
  graphTarget,
  onShowLatest,
  listVersions,
  listLoading,
  listError,
  pagination,
  activeVersion,
  view,
  highlightedVersion,
  onViewChange,
  onViewFiles,
  onViewTrajectory,
  onRevealObservation,
  onCompare,
  onSetCurrent,
  onHighlightEnd
}: {
  /** The newest versions; the graph draws only this window. */
  graphVersions: Version[]
  graphLoading: boolean
  graphError: string
  /** True when older versions exist beyond the graph window. */
  graphTarget?: number | undefined
  onShowLatest?: () => void
  /** One page of version history for the list view. */
  listVersions: Version[]
  listLoading: boolean
  listError: string
  pagination: React.ComponentProps<typeof CursorPagination>
  activeVersion: number | undefined
  view: string
  highlightedVersion: number | undefined
  onViewChange: (view: string) => void
  onViewFiles: (version: number) => void
  onViewTrajectory: (version: number) => void
  onRevealObservation: (version: number, extractionId: string) => void
  onCompare: (version: Version) => void
  onSetCurrent: (version: number) => void
  onHighlightEnd: () => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const isGraph = view === 'graph'
  const versions = isGraph ? graphVersions : listVersions
  const loading = isGraph ? graphLoading : listLoading
  const error = isGraph ? graphError : listError

  // An empty later page is not an empty history, so only page one shows the empty state.
  if (!loading && versions.length === 0 && !error && pagination.page === 1) {
    return <EmptyState message={t('noVersions')} />
  }

  return (
    <>
      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}
      {loading && versions.length === 0 && <LoadingState message={t('loading')} />}
      <Group justify="end" mb="md">
        <SegmentedControl
          value={view}
          onChange={onViewChange}
          data={[
            { label: t('versionGraph'), value: 'graph' },
            { label: t('versionList'), value: 'list' }
          ]}
        />
      </Group>
      {isGraph ? (
        <VersionGraph
          windowHelp={t(graphTarget === undefined ? 'versionGraphWindow' : 'versionGraphCentered', {
            count: String(GRAPH_VERSION_WINDOW)
          })}
          historical={graphTarget !== undefined}
          onShowLatest={onShowLatest}
          versions={versions}
          activeVersion={activeVersion}
          allowSetCurrent={activeVersion !== undefined}
          onViewFiles={onViewFiles}
          onViewTrajectory={onViewTrajectory}
          onRevealObservation={onRevealObservation}
          onCompare={onCompare}
          onSetCurrent={onSetCurrent}
          focusVersion={graphTarget}
          highlightedVersion={highlightedVersion}
          onHighlightEnd={onHighlightEnd}
        />
      ) : (
        <div className="memory-table">
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th className="memory-version-cell">{t('version')}</Table.Th>
                <Table.Th className="memory-predecessor-cell">{t('predecessorVersion')}</Table.Th>
                <Table.Th>{t('versionMethod')}</Table.Th>
                <Table.Th>{t('created')}</Table.Th>
                <Table.Th>{t('actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {versions.map((item) => (
                <Table.Tr
                  key={item.version}
                  data-memory-version={item.version}
                  tabIndex={-1}
                  className={
                    activeVersion !== undefined && item.version === activeVersion
                      ? 'memory-current-row'
                      : ''
                  }
                  aria-current={
                    activeVersion !== undefined && item.version === activeVersion
                      ? 'true'
                      : undefined
                  }
                >
                  <Table.Td data-label={t('version')} className="memory-version-cell">
                    {item.version}
                  </Table.Td>
                  <Table.Td
                    data-label={t('predecessorVersion')}
                    className="memory-predecessor-cell"
                  >
                    {item.predecessor_version ?? '—'}
                  </Table.Td>
                  <Table.Td data-label={t('versionMethod')}>
                    {item.source.kind === 'learning'
                      ? t('sourceLearning')
                      : item.source.kind === 'reorganization'
                        ? t('sourceReorganization')
                        : t('sourceManual')}
                  </Table.Td>
                  <Table.Td data-label={t('created')}>
                    {formatDate(item.created_at, language)}
                  </Table.Td>
                  <Table.Td data-label={t('actions')}>
                    <div className="memory-version-actions">
                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconEye size={ICON_SIZE.sm} />}
                        onClick={() => onViewFiles(item.version)}
                      >
                        {t('tree')}
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconArrowsDiff size={ICON_SIZE.sm} />}
                        onClick={() => onCompare(item)}
                      >
                        {t('compareWithPredecessor')}
                      </Button>
                      {item.source.kind !== 'manual' ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconEye size={ICON_SIZE.sm} />}
                          onClick={() => onViewTrajectory(item.version)}
                        >
                          {t('trajectory')}
                        </Button>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      {item.source.kind !== 'manual' ? (
                        <MaintenanceReportButton
                          report={item.source.maintenance_report}
                          onRevealObservation={(extractionId) =>
                            onRevealObservation(item.version, extractionId)
                          }
                        />
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      {activeVersion !== undefined && item.version === activeVersion ? (
                        <div className="memory-current-action memory-current-indicator">
                          <IconHistory size={ICON_SIZE.sm} />
                          {t('alreadyCurrent')}
                        </div>
                      ) : activeVersion !== undefined ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconHistory size={ICON_SIZE.sm} />}
                          className="memory-current-action"
                          onClick={() => onSetCurrent(item.version)}
                        >
                          {t('restore')}
                        </Button>
                      ) : (
                        <span className="memory-current-action" aria-hidden="true" />
                      )}
                    </div>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {!isGraph && <CursorPagination {...pagination} />}
    </>
  )
}
