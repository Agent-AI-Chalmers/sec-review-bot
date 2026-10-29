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
import { ICON_SIZE } from '../../shared/design.js'

type Observation = ObservationRecord

export function MemoryObservationList({
  observations,
  loading,
  error,
  onRevealRevision,
  onViewTrajectory
}: {
  observations: Observation[]
  loading: boolean
  error: string
  onRevealRevision: (revision: number) => void
  onViewTrajectory: (observation: Observation) => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const [selectedObservation, setSelectedObservation] =
    React.useState<Observation>()

  if (!loading && observations.length === 0 && !error)
    return <EmptyState message={t('noObservations')} />

  return (
    <>
      {error && (
        <Alert color="red" mb="md">
          {error}
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
              <Table.Tr key={item.extraction_id}>
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
