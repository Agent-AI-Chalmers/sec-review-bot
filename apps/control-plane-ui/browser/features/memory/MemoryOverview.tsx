import type React from 'react'
import { MemoryTrend } from './MemoryTrend.js'
import { SegmentedControl, Table, Tooltip } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'

import { workflowLabel } from '../../shared/format.js'
import { ICON_SIZE } from '../../shared/design.js'
import { useMessages } from '../../shared/i18n.js'
import { EmptyState } from '../../shared/StateMessage.js'
import type {
  CatalogOverview as CatalogOverviewContract,
  GetCatalogOverviewQuery
} from './api-types.generated.js'

export type CatalogOverview = CatalogOverviewContract

function percent(part: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`
}

export type OverviewRange = NonNullable<GetCatalogOverviewQuery['range']>

export function MemoryOverview({
  overview,
  range,
  onRangeChange
}: {
  overview: CatalogOverview
  range: OverviewRange
  onRangeChange: (range: OverviewRange) => void
}): React.JSX.Element {
  const t = useMessages()
  const totals = overview.totals
  const yieldValue = percent(
    totals.units_with_observation_count,
    totals.extracted_unit_count
  )

  return (
    <div className="memory-overview">
      <section
        className="memory-overview-metrics"
        aria-label={t('memoryOverview')}
      >
        <div className="memory-overview-metric">
          <span>{t('extractedUnits')}</span>
          <strong>{totals.extracted_unit_count.toLocaleString()}</strong>
          <small>
            {t('completedExtractions')}:{' '}
            {totals.completed_extraction_count.toLocaleString()}
          </small>
        </div>
        <div className="memory-overview-metric">
          <span>{t('unitsWithObservation')}</span>
          <strong>
            {totals.units_with_observation_count.toLocaleString()}
          </strong>
          <small>{yieldValue}</small>
        </div>
        <div className="memory-overview-metric">
          <span className="memory-overview-label">
            {t('unitsWithoutObservation')}
            <Tooltip label={t('unitsWithoutObservationHelp')}>
              <IconInfoCircle
                size={ICON_SIZE.md}
                aria-label={t('unitsWithoutObservationHelp')}
              />
            </Tooltip>
          </span>
          <strong>
            {totals.units_without_observation_count.toLocaleString()}
          </strong>
          <small>
            {percent(
              totals.units_without_observation_count,
              totals.extracted_unit_count
            )}
          </small>
        </div>
        <div className="memory-overview-metric">
          <span>{t('observationYield')}</span>
          <strong>{yieldValue}</strong>
          <small>
            {totals.observation_count.toLocaleString()} {t('observationsUnit')}
          </small>
        </div>
      </section>

      <section className="memory-overview-section">
        <div className="memory-overview-heading">
          <h2>{t('extractionTrend')}</h2>
          <div className="memory-overview-trend-controls">
            <div className="memory-overview-legend">
              <span>
                <i className="memory-overview-swatch extracted" />
                {t('extractedUnits')}
              </span>
              <span>
                <i className="memory-overview-swatch observed" />
                {t('unitsWithObservation')}
              </span>
            </div>
            <SegmentedControl
              size="xs"
              value={range}
              onChange={(value) => onRangeChange(value as OverviewRange)}
              data={[
                { value: '30d', label: t('range30Days') },
                { value: '90d', label: t('range90Days') },
                { value: 'all', label: t('rangeAll') }
              ]}
            />
          </div>
        </div>
        <MemoryTrend overview={overview} />
      </section>

      <section className="memory-overview-section memory-overview-workflows">
        <div className="memory-overview-workflows-head">
          <h2>{t('workflowBreakdown')}</h2>
          <div className="memory-overview-lifecycle-inline">
            <span className="memory-overview-lifecycle-inline-label">
              {t('observationLifecycle')}
            </span>
            <span>
              <i className="memory-overview-lifecycle-swatch pending" />
              {t('pendingObservations')}
              <strong>
                {totals.pending_observation_count.toLocaleString()}
              </strong>
            </span>
            <span>
              <i className="memory-overview-lifecycle-swatch consumed" />
              {t('consumedObservations')}
              <strong>
                {totals.consumed_observation_count.toLocaleString()}
              </strong>
            </span>
          </div>
        </div>
        {overview.workflows.length === 0 ? (
          <EmptyState message={t('noWorkflowData')} />
        ) : (
          <Table className="memory-overview-workflows-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('workflow')}</Table.Th>
                <Table.Th ta="right">{t('extractedUnits')}</Table.Th>
                <Table.Th ta="right">{t('unitsWithObservation')}</Table.Th>
                <Table.Th ta="right">{t('unitsWithoutObservation')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {overview.workflows.map((item) => (
                <Table.Tr key={item.source_workflow}>
                  <Table.Td data-label={t('workflow')}>
                    {workflowLabel(item.source_workflow, t)}
                  </Table.Td>
                  <Table.Td data-label={t('extractedUnits')} ta="right">
                    {item.extracted_unit_count}
                  </Table.Td>
                  <Table.Td data-label={t('unitsWithObservation')} ta="right">
                    {item.units_with_observation_count}
                  </Table.Td>
                  <Table.Td
                    data-label={t('unitsWithoutObservation')}
                    ta="right"
                  >
                    {item.units_without_observation_count}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
            <Table.Tfoot>
              <Table.Tr>
                <Table.Th>{t('lifecycleTotal')}</Table.Th>
                <Table.Th data-label={t('extractedUnits')} ta="right">
                  {totals.extracted_unit_count.toLocaleString()}
                </Table.Th>
                <Table.Th data-label={t('unitsWithObservation')} ta="right">
                  {totals.units_with_observation_count.toLocaleString()}
                </Table.Th>
                <Table.Th data-label={t('unitsWithoutObservation')} ta="right">
                  {totals.units_without_observation_count.toLocaleString()}
                </Table.Th>
              </Table.Tr>
            </Table.Tfoot>
          </Table>
        )}
      </section>
    </div>
  )
}
