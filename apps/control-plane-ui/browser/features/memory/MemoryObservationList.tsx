import React from 'react'
import { Alert, Anchor, Button, Group, Modal, Table } from '@mantine/core'
import { IconEye } from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import remarkGfm from 'remark-gfm'

import { abbreviate } from '../../shared/format.js'
import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import { EmptyState, LoadingState } from '../../shared/StateMessage.js'
import type { ObservationRecord } from './api-types.generated.js'
import { CursorPagination } from '../../shared/CursorPagination.js'
import { ICON_SIZE } from '../../shared/design.js'

type Observation = ObservationRecord

export function MemoryObservationList({
  observations,
  loading,
  error,
  pagination,
  revisionFilter,
  onClearRevisionFilter,
  highlightedExtraction,
  onHighlightEnd,
  onRevealRevision,
  onViewTrajectory
}: {
  observations: Observation[]
  loading: boolean
  error: string
  pagination: React.ComponentProps<typeof CursorPagination>
  revisionFilter: number | undefined
  onClearRevisionFilter: () => void
  highlightedExtraction: string | undefined
  onHighlightEnd: () => void
  onRevealRevision: (revision: number) => void
  onViewTrajectory: (observation: Observation) => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const [selectedObservation, setSelectedObservation] =
    React.useState<Observation>()

  // Reveal a requested observation: scroll to, focus, and highlight its row.
  const targetLoaded =
    highlightedExtraction !== undefined &&
    observations.some((item) => item.extraction_id === highlightedExtraction)
  React.useEffect(() => {
    if (highlightedExtraction === undefined || !targetLoaded) return
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-extraction-row="${CSS.escape(highlightedExtraction)}"]`
      )
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row?.focus({ preventScroll: true })
    })
    return (): void => cancelAnimationFrame(frame)
  }, [highlightedExtraction, targetLoaded])
  const targetMissing =
    highlightedExtraction !== undefined && !targetLoaded && !loading && !error

  const filterBanner = revisionFilter !== undefined && (
    <Alert color="gray" mb="md">
      <Group justify="space-between" gap="xs">
        <span>
          {t('observationsForRevision').replace(
            '{revision}',
            String(revisionFilter)
          )}
        </span>
        <Button size="xs" variant="subtle" onClick={onClearRevisionFilter}>
          {t('showAllObservations')}
        </Button>
      </Group>
    </Alert>
  )

  // An empty later page is not an empty list, so only page one shows the empty state.
  if (!loading && observations.length === 0 && !error && pagination.page === 1)
    return (
      <>
        {filterBanner}
        <EmptyState message={t('noObservations')} />
      </>
    )

  return (
    <>
      {filterBanner}
      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}
      {targetMissing && (
        <Alert color="yellow" mb="md">
          {t('observationNotFound')}
        </Alert>
      )}
      {loading && observations.length === 0 && (
        <LoadingState message={t('loading')} />
      )}
      <div className="memory-table">
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th className="memory-observation-index">
                {t('observation')}
              </Table.Th>
              <Table.Th>{t('sourceRun')}</Table.Th>
              <Table.Th>{t('observationOutcome')}</Table.Th>
              <Table.Th>{t('created')}</Table.Th>
              <Table.Th>{t('actions')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {observations.map((item, index) => (
              <Table.Tr
                key={item.extraction_id}
                data-extraction-row={item.extraction_id}
                tabIndex={-1}
                data-highlighted={
                  item.extraction_id === highlightedExtraction || undefined
                }
                onAnimationEnd={(event) => {
                  if (
                    event.currentTarget === event.target &&
                    item.extraction_id === highlightedExtraction
                  )
                    onHighlightEnd()
                }}
              >
                {/* This is deliberately a display index, not an extraction identity. */}
                <Table.Td className="memory-observation-index">
                  {index + 1}
                </Table.Td>
                <Table.Td>
                  <Anchor
                    component={Link}
                    to={`/runs/${encodeURIComponent(item.source_run_id)}`}
                    ff="monospace"
                    title={item.source_run_id}
                  >
                    {abbreviate(item.source_run_id, 8, 4)}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  {item.consumed_revision ? (
                    <span className="memory-incorporation">
                      <span>{t('incorporatedInto')}</span>
                      <Anchor
                        component="button"
                        type="button"
                        className="memory-revision-link"
                        onClick={() =>
                          onRevealRevision(item.consumed_revision!)
                        }
                      >
                        {t('revisionReference').replace(
                          '{revision}',
                          String(item.consumed_revision)
                        )}
                      </Anchor>
                    </span>
                  ) : (
                    t('statusPending')
                  )}
                </Table.Td>
                <Table.Td>{formatDate(item.created_at, language)}</Table.Td>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconEye size={ICON_SIZE.sm} />}
                      onClick={() => setSelectedObservation(item)}
                    >
                      {t('content')}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconEye size={ICON_SIZE.sm} />}
                      onClick={() => onViewTrajectory(item)}
                    >
                      {t('trajectory')}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <CursorPagination {...pagination} />
      <Modal
        opened={selectedObservation !== undefined}
        onClose={() => setSelectedObservation(undefined)}
        title={t('observationDetail')}
        size="lg"
        centered
      >
        <div className="memory-markdown memory-markdown-full">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {selectedObservation?.body_markdown ?? ''}
          </ReactMarkdown>
        </div>
      </Modal>
    </>
  )
}
