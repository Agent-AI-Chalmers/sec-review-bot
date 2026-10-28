import React from 'react'
import { Button, Group, Paper, Text } from '@mantine/core'
import { IconArrowsDiff, IconEye, IconHistory } from '@tabler/icons-react'

import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import type { MemoryTreeRevision } from './api-types.generated.js'
import { ICON_SIZE } from '../../shared/design.js'

export type RevisionGraphItem = MemoryTreeRevision

interface PositionedRevision extends RevisionGraphItem {
  x: number
  y: number
}

const NODE_WIDTH = 184
const NODE_HEIGHT = 72
const COLUMN_GAP = 56
const ROW_GAP = 54
const PADDING = 24

function layoutRevisions(revisions: RevisionGraphItem[]): {
  nodes: PositionedRevision[]
  width: number
  height: number
} {
  const items = new Map(revisions.map((item) => [item.revision, item]))
  const children = new Map<number, RevisionGraphItem[]>()
  for (const item of revisions) {
    if (
      item.predecessor_revision === null ||
      !items.has(item.predecessor_revision)
    )
      continue
    const siblings = children.get(item.predecessor_revision) ?? []
    siblings.push(item)
    children.set(item.predecessor_revision, siblings)
  }
  for (const siblings of children.values())
    siblings.sort((left, right) => left.revision - right.revision)

  const roots = revisions
    .filter(
      (item) =>
        item.predecessor_revision === null ||
        !items.has(item.predecessor_revision)
    )
    .sort((left, right) => left.revision - right.revision)
  const xByRevision = new Map<number, number>()
  const visited = new Set<number>()
  let nextLeaf = 0
  const place = (item: RevisionGraphItem): number => {
    if (visited.has(item.revision))
      return xByRevision.get(item.revision) ?? nextLeaf++
    visited.add(item.revision)
    const descendants = children.get(item.revision) ?? []
    const x =
      descendants.length === 0
        ? nextLeaf++
        : descendants.reduce((sum, child) => sum + place(child), 0) /
          descendants.length
    xByRevision.set(item.revision, x)
    return x
  }
  roots.forEach(place)
  revisions
    .filter((item) => !visited.has(item.revision))
    .sort((left, right) => left.revision - right.revision)
    .forEach(place)

  const newestFirst = [...revisions].sort(
    (left, right) => right.revision - left.revision
  )
  const yByRevision = new Map(
    newestFirst.map((item, index) => [
      item.revision,
      PADDING + index * (NODE_HEIGHT + ROW_GAP)
    ])
  )
  const laneCount = Math.max(1, Math.ceil(nextLeaf))
  return {
    nodes: revisions.map((item) => ({
      ...item,
      x:
        PADDING +
        (xByRevision.get(item.revision) ?? 0) * (NODE_WIDTH + COLUMN_GAP),
      y: yByRevision.get(item.revision) ?? PADDING
    })),
    width: PADDING * 2 + laneCount * NODE_WIDTH + (laneCount - 1) * COLUMN_GAP,
    height:
      PADDING * 2 +
      newestFirst.length * NODE_HEIGHT +
      Math.max(0, newestFirst.length - 1) * ROW_GAP
  }
}

export function RevisionGraph({
  revisions,
  activeRevision,
  onViewFiles,
  onViewProcess,
  onCompare,
  onSetCurrent,
  allowSetCurrent,
  highlightedRevision,
  onHighlightEnd
}: {
  revisions: RevisionGraphItem[]
  activeRevision: number | undefined
  onViewFiles: (revision: number) => void
  onViewProcess: (revision: number) => void
  onCompare: (revision: RevisionGraphItem) => void
  onSetCurrent: (revision: number) => void
  allowSetCurrent: boolean
  highlightedRevision: number | undefined
  onHighlightEnd: () => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const [selectedRevision, setSelectedRevision] = React.useState(
    activeRevision ?? 0
  )
  const [panning, setPanning] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const panStart = React.useRef<{
    pointerX: number
    pointerY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)
  React.useEffect(() => {
    if (activeRevision !== undefined) setSelectedRevision(activeRevision)
  }, [activeRevision])
  const layout = React.useMemo(() => layoutRevisions(revisions), [revisions])
  const nodes = new Map(layout.nodes.map((item) => [item.revision, item]))
  const activeLineage = new Set<number>()
  let lineageCursor =
    activeRevision === undefined ? undefined : nodes.get(activeRevision)
  while (lineageCursor && !activeLineage.has(lineageCursor.revision)) {
    activeLineage.add(lineageCursor.revision)
    lineageCursor =
      lineageCursor.predecessor_revision === null
        ? undefined
        : nodes.get(lineageCursor.predecessor_revision)
  }
  const selected = nodes.get(selectedRevision) ?? layout.nodes[0]

  React.useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    // On a narrow canvas the graph is wider than its viewport. Centering the
    // whole canvas can leave the current revision half outside the initial
    // frame, so center the current node instead and fall back to the canvas
    // center only when no revision is current.
    const current =
      activeRevision === undefined
        ? undefined
        : layout.nodes.find((item) => item.revision === activeRevision)
    if (!current) {
      viewport.scrollLeft = Math.max(
        0,
        (viewport.scrollWidth - viewport.clientWidth) / 2
      )
      viewport.scrollTop = 0
      return
    }
    viewport.scrollLeft = Math.max(
      0,
      Math.min(
        viewport.scrollWidth - viewport.clientWidth,
        current.x + NODE_WIDTH / 2 - viewport.clientWidth / 2
      )
    )
    viewport.scrollTop = 0
  }, [layout.height, layout.width, layout.nodes, activeRevision])

  React.useEffect(() => {
    if (highlightedRevision === undefined) return
    const target = layout.nodes.find(
      (item) => item.revision === highlightedRevision
    )
    const viewport = scrollRef.current
    if (!target || !viewport) return
    setSelectedRevision(highlightedRevision)
    const frame = requestAnimationFrame(() => {
      viewport.scrollTo({
        left: Math.max(0, target.x + NODE_WIDTH / 2 - viewport.clientWidth / 2),
        top: Math.max(
          0,
          target.y + NODE_HEIGHT / 2 - viewport.clientHeight / 2
        ),
        behavior: 'smooth'
      })
      viewport
        .querySelector<HTMLElement>(
          `[data-revision-node="${highlightedRevision}"]`
        )
        ?.focus({ preventScroll: true })
    })
    return (): void => cancelAnimationFrame(frame)
  }, [highlightedRevision, layout.nodes])

  return (
    <div className="revision-graph-section">
      <div
        ref={scrollRef}
        className="revision-graph-scroll"
        data-panning={panning || undefined}
        role="region"
        aria-label={t('revisionGraph')}
        tabIndex={0}
        onPointerDown={(event) => {
          if (
            event.pointerType !== 'mouse' ||
            event.button !== 0 ||
            (event.target as HTMLElement).closest('.revision-graph-node')
          )
            return
          panStart.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            scrollLeft: event.currentTarget.scrollLeft,
            scrollTop: event.currentTarget.scrollTop
          }
          setPanning(true)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!panStart.current) return
          event.currentTarget.scrollLeft =
            panStart.current.scrollLeft +
            panStart.current.pointerX -
            event.clientX
          event.currentTarget.scrollTop =
            panStart.current.scrollTop +
            panStart.current.pointerY -
            event.clientY
        }}
        onPointerUp={(event) => {
          if (!panStart.current) return
          panStart.current = null
          setPanning(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      >
        <div
          className="revision-graph"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            className="revision-graph-edges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            {layout.nodes.map((item) => {
              if (item.predecessor_revision === null) return null
              const predecessor = nodes.get(item.predecessor_revision)
              if (!predecessor) return null
              const startX = item.x + NODE_WIDTH / 2
              const startY = item.y + NODE_HEIGHT
              const endX = predecessor.x + NODE_WIDTH / 2
              const endY = predecessor.y
              const middleY = startY + (endY - startY) / 2
              return (
                <path
                  key={`${item.revision}-${predecessor.revision}`}
                  d={`M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`}
                  data-active-line={
                    activeLineage.has(item.revision) &&
                    activeLineage.has(predecessor.revision)
                      ? 'true'
                      : undefined
                  }
                />
              )
            })}
          </svg>
          {layout.nodes.map((item) => (
            <button
              key={item.revision}
              type="button"
              className="revision-graph-node"
              style={{
                left: item.x,
                top: item.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT
              }}
              data-current={
                activeRevision !== undefined && item.revision === activeRevision
                  ? true
                  : undefined
              }
              data-selected={item.revision === selected?.revision || undefined}
              data-highlighted={
                item.revision === highlightedRevision || undefined
              }
              data-revision-node={item.revision}
              onClick={() => setSelectedRevision(item.revision)}
              onAnimationEnd={(event) => {
                if (
                  event.currentTarget === event.target &&
                  item.revision === highlightedRevision
                )
                  onHighlightEnd()
              }}
              aria-label={t('revisionReference').replace(
                '{revision}',
                String(item.revision)
              )}
            >
              <strong>
                {t('revisionReference').replace(
                  '{revision}',
                  String(item.revision)
                )}
              </strong>
              <span>
                {item.source.kind === 'maintenance'
                  ? t('sourceMaintenance')
                  : t('sourceOperatorEdit')}
                {activeRevision !== undefined &&
                item.revision === activeRevision
                  ? ` · ${t('current')}`
                  : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <Paper withBorder p="sm" className="revision-graph-selection">
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600}>
                {t('revisionReference').replace(
                  '{revision}',
                  String(selected.revision)
                )}
              </Text>
              <Text size="sm" c="dimmed">
                {formatDate(selected.created_at, language)} ·{' '}
                {selected.source.kind === 'maintenance'
                  ? t('sourceMaintenance')
                  : t('sourceOperatorEdit')}
              </Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconEye size={ICON_SIZE.sm} />}
                onClick={() => onViewFiles(selected.revision)}
              >
                {t('tree')}
              </Button>
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconArrowsDiff size={ICON_SIZE.sm} />}
                onClick={() => onCompare(selected)}
              >
                {t('compareWithPredecessor')}
              </Button>
              {selected.source.kind === 'maintenance' && (
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconEye size={ICON_SIZE.sm} />}
                  onClick={() => onViewProcess(selected.revision)}
                >
                  {t('process')}
                </Button>
              )}
              {activeRevision !== undefined &&
              selected.revision === activeRevision ? (
                <div className="memory-current-action memory-current-indicator">
                  <IconHistory size={ICON_SIZE.sm} />
                  {t('alreadyCurrent')}
                </div>
              ) : allowSetCurrent ? (
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconHistory size={ICON_SIZE.sm} />}
                  className="memory-current-action"
                  onClick={() => onSetCurrent(selected.revision)}
                >
                  {t('restore')}
                </Button>
              ) : (
                <span className="memory-current-action" aria-hidden="true" />
              )}
            </Group>
          </Group>
        </Paper>
      )}
    </div>
  )
}
