import React from 'react'
import { Paper, Text } from '@mantine/core'

import { useMessages } from '../../shared/i18n.js'
import type { TrajectoryMessageView } from './trajectory-model.js'
import { rolePresentation } from './trajectory-roles.js'
import {
  messageKey,
  scrollToTrajectoryElement
} from './trajectory-navigation.js'
import {
  MAX_MINIMAP_MARKS,
  MINIMAP_HEIGHT,
  minimapBuckets,
  minimapMarkWidth,
  minimapTicks,
  nearestSegment,
  sameSegments,
  type MinimapSegment
} from './trajectory-minimap.js'

export type MinimapPlacement = 'viewport' | 'container'

function scrollParent(element: HTMLElement): HTMLElement | undefined {
  let ancestor = element.parentElement
  while (ancestor) {
    const style = getComputedStyle(ancestor)
    if (/(auto|scroll)/.test(style.overflowY)) return ancestor
    ancestor = ancestor.parentElement
  }
  return undefined
}

function messagePreview(message: TrajectoryMessageView): string {
  const value =
    message.content || message.reasoning || message.name || message.role
  const preview = value.replaceAll(/\s+/g, ' ').trim().slice(0, 120)
  return preview || message.role
}

const MinimapMark = React.memo(function MinimapMark({
  top,
  width,
  current,
  preview
}: {
  top: number
  width: number
  current: boolean
  preview: boolean
}): React.JSX.Element {
  return (
    <span
      className="trajectory-minimap-segment"
      data-current={current ? 'true' : undefined}
      data-preview={preview ? 'true' : undefined}
      style={{ top: `${top}px`, width: `${width}px` }}
    />
  )
})

export function TrajectoryMinimap({
  messages,
  timelineRef,
  timelineId,
  placement
}: {
  messages: TrajectoryMessageView[]
  timelineRef: React.RefObject<HTMLDivElement | null>
  timelineId: string
  placement: MinimapPlacement
}): React.JSX.Element {
  const t = useMessages()
  const [segments, setSegments] = React.useState<MinimapSegment[]>([])
  const [current, setCurrent] = React.useState(0)
  const [hovered, setHovered] = React.useState<number | null>(null)
  const [topOffset, setTopOffset] = React.useState<number | null>(null)

  // A layout effect measures the scrollport before the first paint, so the
  // modal rail never shows its 50vh fallback for a frame.
  React.useLayoutEffect(() => {
    const timeline = timelineRef.current
    if (!timeline) return
    const scroller = scrollParent(timeline)
    const scrollTarget = scroller ?? window
    let layoutFrame = 0
    let scrollFrame = 0
    let measured: MinimapSegment[] = []

    const updateCurrent = (): void => {
      if (measured.length === 0) return
      const timelineRect = timeline.getBoundingClientRect()
      if (timelineRect.height <= 0) return
      const viewportTop = scroller ? scroller.getBoundingClientRect().top : 0
      const viewportHeight = scroller
        ? scroller.clientHeight
        : window.innerHeight
      const center =
        (viewportTop - timelineRect.top + viewportHeight / 2) /
        timelineRect.height
      const next = nearestSegment(measured, center)
      setCurrent((value) => (value === next ? value : next))
    }

    const updateTop = (): void => {
      const height = scroller ? scroller.clientHeight : window.innerHeight
      const next = Math.max(8, (height - MINIMAP_HEIGHT) / 2)
      setTopOffset((value) => (value === next ? value : next))
    }

    const measure = (): void => {
      layoutFrame = 0
      updateTop()
      const timelineRect = timeline.getBoundingClientRect()
      if (timelineRect.height <= 0) return
      const byKey = new Map(
        messages.map((message) => [messageKey(message), message])
      )
      const next: MinimapSegment[] = []
      for (const node of timeline.querySelectorAll<HTMLElement>(
        ':scope > [data-trajectory-message-key]'
      )) {
        const message = byKey.get(node.dataset.trajectoryMessageKey ?? '')
        if (!message) continue
        const rect = node.getBoundingClientRect()
        next.push({
          message,
          top: (rect.top - timelineRect.top) / timelineRect.height,
          height: rect.height / timelineRect.height
        })
      }
      measured = next
      setSegments((value) => (sameSegments(value, next) ? value : next))
      updateCurrent()
    }

    const scheduleMeasure = (): void => {
      cancelAnimationFrame(layoutFrame)
      layoutFrame = requestAnimationFrame(measure)
    }
    const scheduleCurrent = (): void => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(updateCurrent)
    }

    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(timeline)
    scrollTarget.addEventListener('scroll', scheduleCurrent, { passive: true })
    window.addEventListener('resize', scheduleMeasure)
    measure()
    return (): void => {
      cancelAnimationFrame(layoutFrame)
      cancelAnimationFrame(scrollFrame)
      resizeObserver.disconnect()
      scrollTarget.removeEventListener('scroll', scheduleCurrent)
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [messages, timelineRef])

  const ticks = minimapTicks(segments.length)
  if (segments.length === 0)
    return (
      <nav
        className={`trajectory-minimap trajectory-minimap-${placement}`}
        aria-label={t('trajectoryMinimap')}
        style={{
          height: MINIMAP_HEIGHT,
          top: topOffset ?? `calc(50vh - ${MINIMAP_HEIGHT / 2}px)`
        }}
      />
    )

  const active = Math.min(current, segments.length - 1)
  const dense = segments.length > MAX_MINIMAP_MARKS
  const buckets = dense ? minimapBuckets(segments.length, ticks) : []
  const currentBucket = dense
    ? buckets.find((bucket) => bucket.start <= active && active <= bucket.end)
    : undefined
  const hoveredIndex =
    hovered === null ? null : Math.min(hovered, segments.length - 1)
  const hoveredMessage =
    hoveredIndex === null ? undefined : segments[hoveredIndex]?.message
  const currentMessage = segments[active]?.message
  const currentLabel = currentMessage
    ? `${t(rolePresentation(currentMessage.role).key)} #${currentMessage.seq}: ${messagePreview(currentMessage)}`
    : undefined

  const indexAt = (clientY: number, rect: DOMRect): number => {
    if (ticks.gap === 0) return 0
    return Math.max(
      0,
      Math.min(
        segments.length - 1,
        Math.round((clientY - rect.top - ticks.start) / ticks.gap)
      )
    )
  }

  const navigate = (index: number): void => {
    const message = segments[index]?.message
    if (!message) return
    // The rail is a direct ordering control: jump instantly and let the scroll
    // listener derive the current message. A smooth scroll would keep firing
    // scroll events while a second key press still uses the old index.
    scrollToTrajectoryElement(`trajectory-${message.id}`, 'auto')
  }

  return (
    <nav
      className={`trajectory-minimap trajectory-minimap-${placement}`}
      aria-label={t('trajectoryMinimap')}
      style={{
        height: MINIMAP_HEIGHT,
        top: topOffset ?? `calc(50vh - ${MINIMAP_HEIGHT / 2}px)`
      }}
    >
      <div
        className="trajectory-minimap-track"
        role="slider"
        tabIndex={0}
        aria-label={t('trajectoryMinimapPosition')}
        aria-controls={timelineId}
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={segments.length}
        aria-valuenow={active + 1}
        aria-valuetext={currentLabel}
        onClick={(event) => {
          navigate(
            indexAt(event.clientY, event.currentTarget.getBoundingClientRect())
          )
        }}
        onMouseMove={(event) => {
          setHovered(
            indexAt(event.clientY, event.currentTarget.getBoundingClientRect())
          )
        }}
        onMouseLeave={() => setHovered(null)}
        onFocus={() => setHovered(active)}
        onBlur={() => setHovered(null)}
        onKeyDown={(event) => {
          const last = segments.length - 1
          let next: number | undefined
          if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
            next = Math.max(0, active - 1)
          else if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
            next = Math.min(last, active + 1)
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = last
          else if (event.key === 'Enter' || event.key === ' ') next = active
          if (next === undefined) return
          event.preventDefault()
          setHovered(next)
          navigate(next)
        }}
      >
        <div className="trajectory-minimap-marks" aria-hidden="true">
          {dense ? (
            <>
              {buckets.map((bucket) => {
                const preview =
                  hoveredIndex !== null &&
                  bucket.start <= hoveredIndex &&
                  hoveredIndex <= bucket.end
                return (
                  <MinimapMark
                    key={`bucket-${bucket.start}`}
                    top={bucket.top}
                    width={minimapMarkWidth(false, preview)}
                    current={false}
                    preview={preview}
                  />
                )
              })}
              {currentMessage && (
                <MinimapMark
                  key="current"
                  top={currentBucket?.top ?? ticks.start + active * ticks.gap}
                  width={minimapMarkWidth(true, false)}
                  current
                  preview={false}
                />
              )}
            </>
          ) : (
            segments.map((segment, index) => {
              const preview = index === hoveredIndex
              return (
                <MinimapMark
                  key={messageKey(segment.message)}
                  top={ticks.start + index * ticks.gap}
                  width={minimapMarkWidth(index === active, preview)}
                  current={index === active}
                  preview={preview}
                />
              )
            })
          )}
        </div>
      </div>
      {hoveredMessage && hoveredIndex !== null && (
        <Paper
          withBorder
          p="xs"
          className="trajectory-minimap-preview"
          aria-hidden="true"
          style={{ top: `${ticks.start + hoveredIndex * ticks.gap}px` }}
        >
          <Text size="xs" fw={700}>
            {t(rolePresentation(hoveredMessage.role).key)} · #
            {hoveredMessage.seq}
          </Text>
          <Text size="xs" lineClamp={3} c="dimmed">
            {messagePreview(hoveredMessage)}
          </Text>
        </Paper>
      )}
    </nav>
  )
}
