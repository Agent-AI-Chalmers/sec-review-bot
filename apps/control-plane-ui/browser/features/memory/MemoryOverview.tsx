import React from 'react'
import { SegmentedControl, Table, Tooltip } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'

import { workflowLabel } from '../../shared/format.js'
import { useLanguage, useMessages } from '../../shared/i18n.js'
import type { components, operations } from './api-types.generated.js'

export type CatalogOverview = components['schemas']['CatalogOverview']

function percent(part: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`
}

export type OverviewRange = NonNullable<
  NonNullable<operations['getCatalogOverview']['parameters']['query']>['range']
>

function Trend({ overview }: { overview: CatalogOverview }): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const width = 720
  const height = 220
  const padding = { top: 18, right: 14, bottom: 34, left: 38 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const maximum = Math.max(
    1,
    ...overview.trend_points.map((point) => point.extracted_unit_count)
  )
  const point = (value: number, index: number): string => {
    const x =
      padding.left +
      (overview.trend_points.length <= 1
        ? plotWidth / 2
        : (index / (overview.trend_points.length - 1)) * plotWidth)
    const y = padding.top + plotHeight - (value / maximum) * plotHeight
    return `${x},${y}`
  }
  const labels = [
    0,
    Math.floor((overview.trend_points.length - 1) / 2),
    overview.trend_points.length - 1
  ]
    .filter(
      (value, index, values) => value >= 0 && values.indexOf(value) === index
    )
    .map((index) => ({
      index,
      periodStart: overview.trend_points[index]?.period_start
    }))

  return (
    <div className="memory-overview-trend-scroll">
      <svg
        className="memory-overview-trend"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('extractionTrend')}
      >
        {[0, 0.5, 1].map((ratio) => {
          const y = padding.top + plotHeight * ratio
          return (
            <line
              key={ratio}
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              className="memory-overview-gridline"
            />
          )
        })}
        <polyline
          points={overview.trend_points
            .map((trendPoint, index) =>
              point(trendPoint.extracted_unit_count, index)
            )
            .join(' ')}
          className="memory-overview-line memory-overview-line-extracted"
        />
        <polyline
          points={overview.trend_points
            .map((trendPoint, index) =>
              point(trendPoint.units_with_observation_count, index)
            )
            .join(' ')}
          className="memory-overview-line memory-overview-line-observed"
        />
        <text x={padding.left - 8} y={padding.top + 4} textAnchor="end">
          {maximum}
        </text>
        <text
          x={padding.left - 8}
          y={padding.top + plotHeight + 4}
          textAnchor="end"
        >
          0
        </text>
        {labels.map(({ index, periodStart }) => {
          const x =
            padding.left +
            (overview.trend_points.length <= 1
              ? plotWidth / 2
              : (index / (overview.trend_points.length - 1)) * plotWidth)
          return (
            <text
              key={index}
              x={x}
              y={height - 8}
              textAnchor={
                index === 0
                  ? 'start'
                  : index === overview.trend_points.length - 1
                    ? 'end'
                    : 'middle'
              }
            >
              {periodStart
                ? new Date(`${periodStart}T00:00:00Z`).toLocaleDateString(
                    language === 'zh' ? 'zh-CN' : 'en-US',
                    overview.trend_granularity === 'month'
                      ? { year: 'numeric', month: 'short', timeZone: 'UTC' }
                      : { month: 'short', day: 'numeric', timeZone: 'UTC' }
                  )
                : ''}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

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
                size={15}
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
        <Trend overview={overview} />
      </section>

      <div className="memory-overview-lower">
        <section className="memory-overview-section">
          <h2>{t('observationLifecycle')}</h2>
          <div className="memory-overview-outcome">
            <span>{t('pendingObservations')}</span>
            <strong>{totals.pending_observation_count.toLocaleString()}</strong>
          </div>
          <div className="memory-overview-outcome">
            <span>{t('consumedObservations')}</span>
            <strong>
              {totals.consumed_observation_count.toLocaleString()}
            </strong>
          </div>
        </section>
        <section className="memory-overview-section memory-overview-workflows">
          <h2>{t('workflowBreakdown')}</h2>
          <Table>
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
                  <Table.Td>{workflowLabel(item.source_workflow, t)}</Table.Td>
                  <Table.Td ta="right">{item.extracted_unit_count}</Table.Td>
                  <Table.Td ta="right">
                    {item.units_with_observation_count}
                  </Table.Td>
                  <Table.Td ta="right">
                    {item.units_without_observation_count}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </section>
      </div>
    </div>
  )
}
