import React from 'react'
import { Alert, Button, Group, SegmentedControl, Table } from '@mantine/core'
import { IconArrowsDiff, IconEye, IconHistory } from '@tabler/icons-react'

import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import { EmptyState, LoadingState } from '../../shared/StateMessage.js'
import type { components } from './api-types.generated.js'
import { RevisionGraph } from './RevisionGraph.js'
import { ICON_SIZE } from '../../shared/design.js'

type Revision = components['schemas']['MemoryTreeRevision']

export function MemoryRevisionHistory({
  revisions,
  activeRevision,
  loading,
  error,
  view,
  highlightedRevision,
  onViewChange,
  onViewFiles,
  onViewProcess,
  onCompare,
  onSetCurrent,
  onHighlightEnd
}: {
  revisions: Revision[]
  activeRevision: number | undefined
  loading: boolean
  error: string
  view: string
  highlightedRevision: number | undefined
  onViewChange: (view: string) => void
  onViewFiles: (revision: number) => void
  onViewProcess: (revision: number) => void
  onCompare: (revision: Revision) => void
  onSetCurrent: (revision: number) => void
  onHighlightEnd: () => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()

  if (!loading && revisions.length === 0 && !error)
    return <EmptyState message={t('noRevisions')} />

  return (
    <>
      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}
      {loading && revisions.length === 0 && (
        <LoadingState message={t('loading')} />
      )}
      <Group justify="end" mb="md">
        <SegmentedControl
          value={view}
          onChange={onViewChange}
          data={[
            { label: t('revisionGraph'), value: 'graph' },
            { label: t('revisionList'), value: 'list' }
          ]}
        />
      </Group>
      {view === 'graph' ? (
        <RevisionGraph
          revisions={revisions}
          activeRevision={activeRevision}
          allowSetCurrent={activeRevision !== undefined}
          onViewFiles={onViewFiles}
          onViewProcess={onViewProcess}
          onCompare={onCompare}
          onSetCurrent={onSetCurrent}
          highlightedRevision={highlightedRevision}
          onHighlightEnd={onHighlightEnd}
        />
      ) : (
        <div className="memory-table">
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th className="memory-revision-cell">
                  {t('revision')}
                </Table.Th>
                <Table.Th className="memory-predecessor-cell">
                  {t('predecessorRevision')}
                </Table.Th>
                <Table.Th>{t('revisionMethod')}</Table.Th>
                <Table.Th>{t('created')}</Table.Th>
                <Table.Th>{t('actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {revisions.map((item) => (
                <Table.Tr
                  key={item.revision}
                  data-memory-revision={item.revision}
                  tabIndex={-1}
                  className={
                    activeRevision !== undefined &&
                    item.revision === activeRevision
                      ? 'memory-current-row'
                      : ''
                  }
                  aria-current={
                    activeRevision !== undefined &&
                    item.revision === activeRevision
                      ? 'true'
                      : undefined
                  }
                >
                  <Table.Td className="memory-revision-cell">
                    {item.revision}
                  </Table.Td>
                  <Table.Td className="memory-predecessor-cell">
                    {item.predecessor_revision ?? '—'}
                  </Table.Td>
                  <Table.Td>
                    {item.source.kind === 'maintenance'
                      ? t('sourceMaintenance')
                      : t('sourceOperatorEdit')}
                  </Table.Td>
                  <Table.Td>{formatDate(item.created_at, language)}</Table.Td>
                  <Table.Td>
                    <div className="memory-revision-actions">
                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconEye size={ICON_SIZE.sm} />}
                        onClick={() => onViewFiles(item.revision)}
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
                      {item.source.kind === 'maintenance' ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconEye size={ICON_SIZE.sm} />}
                          onClick={() => onViewProcess(item.revision)}
                        >
                          {t('process')}
                        </Button>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                      {activeRevision !== undefined &&
                      item.revision === activeRevision ? (
                        <div className="memory-current-action memory-current-indicator">
                          <IconHistory size={ICON_SIZE.sm} />
                          {t('alreadyCurrent')}
                        </div>
                      ) : activeRevision !== undefined ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconHistory size={ICON_SIZE.sm} />}
                          className="memory-current-action"
                          onClick={() => onSetCurrent(item.revision)}
                        >
                          {t('restore')}
                        </Button>
                      ) : (
                        <span
                          className="memory-current-action"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </>
  )
}
