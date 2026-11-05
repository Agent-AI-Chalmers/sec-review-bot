import React from 'react'
import { useLanguage, useMessages } from '../../shared/i18n.js'
import type { CatalogOverview } from './api-types.generated.js'

export function MemoryTrend({
  overview
}: {
  overview: CatalogOverview
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(720)
  const height = 220
  React.useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = (): void => {
      const next = Math.max(
        320,
        Math.round(element.getBoundingClientRect().width)
      )
      setWidth((current) => (current === next ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return (): void => observer.disconnect()
  }, [])
  const padding = { top: 18, right: 38, bottom: 34, left: 38 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  // A wide window can be almost entirely empty. Start at the first period with
  // activity (keeping one baseline point) so the default view is not a flat line.
  const firstActive = overview.trend_points.findIndex(
    (point) =>
      point.extracted_unit_count > 0 || point.units_with_observation_count > 0
  )
  const trendPoints =
    firstActive > 0
      ? overview.trend_points.slice(Math.max(0, firstActive - 1))
      : overview.trend_points
  const maximum = Math.max(
    1,
    ...trendPoints.map((point) => point.extracted_unit_count)
  )
  const point = (value: number, index: number): string => {
    const x =
      padding.left +
      (trendPoints.length <= 1
        ? plotWidth / 2
        : (index / (trendPoints.length - 1)) * plotWidth)
    const y = padding.top + plotHeight - (value / maximum) * plotHeight
    return `${x},${y}`
  }
  const labels = [
    0,
    Math.floor((trendPoints.length - 1) / 2),
    trendPoints.length - 1
  ]
    .filter(
      (value, index, values) => value >= 0 && values.indexOf(value) === index
    )
    .map((index) => ({
      index,
      periodStart: trendPoints[index]?.period_start
    }))

  return (
    <div className="memory-overview-trend-scroll" ref={scrollRef}>
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
          points={trendPoints
            .map((trendPoint, index) =>
              point(trendPoint.extracted_unit_count, index)
            )
            .join(' ')}
          className="memory-overview-line memory-overview-line-extracted"
        />
        <polyline
          points={trendPoints
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
            (trendPoints.length <= 1
              ? plotWidth / 2
              : (index / (trendPoints.length - 1)) * plotWidth)
          return (
            <text
              key={index}
              x={x}
              y={height - 8}
              textAnchor={
                index === 0
                  ? 'start'
                  : index === trendPoints.length - 1
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
