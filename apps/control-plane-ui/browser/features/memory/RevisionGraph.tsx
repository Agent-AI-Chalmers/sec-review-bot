import React from 'react'
import { Button, Group, Paper, Text, Tooltip, ActionIcon } from '@mantine/core'
import {
  IconArrowsDiff,
  IconEye,
  IconHistory,
  IconInfoCircle,
  IconArrowUp
} from '@tabler/icons-react'

import { formatDate, useLanguage, useMessages } from '../../shared/i18n.js'
import type { MemoryTreeRevision } from './api-types.generated.js'
import { MaintenanceReportButton } from './MaintenanceReport.js'
import { BREAKPOINTS, ICON_SIZE } from '../../shared/design.js'

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

  const newestFirst = revisions.toSorted(
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
  windowHelp,
  historical,
  onShowLatest,
  activeRevision,
  onViewFiles,
  onViewTrajectory,
  onRevealObservation,
  onCompare,
  onSetCurrent,
  allowSetCurrent,
  highlightedRevision,
  focusRevision,
  onHighlightEnd
}: {
  revisions: RevisionGraphItem[]
  windowHelp: string
  historical: boolean
  onShowLatest: (() => void) | undefined
  activeRevision: number | undefined
  onViewFiles: (revision: number) => void
  onViewTrajectory: (revision: number) => void
  onRevealObservation: (revision: number, extractionId: string) => void
  onCompare: (revision: RevisionGraphItem) => void
  onSetCurrent: (revision: number) => void
  allowSetCurrent: boolean
  focusRevision?: number | undefined
  highlightedRevision: number | undefined
  onHighlightEnd: () => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const [selectedRevision, setSelectedRevision] = React.useState(
    activeRevision ?? 0
  )
  const selectionRef = React.useRef<HTMLDivElement>(null)
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

  const positioned = React.useRef<string | undefined>(undefined)
  const navigationTarget = highlightedRevision ?? focusRevision
  const requestedPosition =
    navigationTarget === undefined ? 'latest' : `revision:${navigationTarget}`
  React.useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (!viewport || layout.nodes.length === 0) return
    // Refreshes replace the rows, but only an explicit navigation changes the
    // requested position. Preserve the reader's pan/scroll through data updates.
    if (positioned.current === requestedPosition) return
    const target = layout.nodes.find(
      (item) => item.revision === navigationTarget
    )
    if (navigationTarget !== undefined && !target) return
    positioned.current = requestedPosition
    const current =
      target ?? layout.nodes.find((item) => item.revision === activeRevision)
    viewport.scrollLeft = Math.max(
      0,
      current
        ? current.x + NODE_WIDTH / 2 - viewport.clientWidth / 2
        : (viewport.scrollWidth - viewport.clientWidth) / 2
    )
    viewport.scrollTop = target
      ? Math.max(0, target.y + NODE_HEIGHT / 2 - viewport.clientHeight / 2)
      : 0
    if (target) {
      setSelectedRevision(target.revision)
      viewport
        .querySelector<HTMLElement>(`[data-revision-node="${target.revision}"]`)
        ?.focus({ preventScroll: true })
    }
  }, [requestedPosition, navigationTarget, layout.nodes, activeRevision])

  const revisionNumbers = revisions.map((item) => item.revision)
  const rangeStart = revisionNumbers.length
    ? String(Math.min(...revisionNumbers))
    : '—'
  const rangeEnd = revisionNumbers.length
    ? String(Math.max(...revisionNumbers))
    : '—'

  return (
    <div className="revision-graph-section">
      <div className="revision-graph-frame">
        <Group
          className="revision-graph-toolbar"
          justify="space-between"
          gap="xs"
        >
          <Group gap="xs">
            <Text size="sm" c="var(--muted)">
              {t('revisionGraphRange', { from: rangeStart, to: rangeEnd })}
            </Text>
            <Tooltip label={windowHelp} multiline w={260}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={windowHelp}
              >
                <IconInfoCircle size={ICON_SIZE.sm} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconArrowUp size={ICON_SIZE.sm} />}
            disabled={!historical}
            onClick={onShowLatest}
          >
            {t('revisionGraphLatest')}
          </Button>
        </Group>
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
                  activeRevision !== undefined &&
                  item.revision === activeRevision
                    ? true
                    : undefined
                }
                data-selected={
                  item.revision === selected?.revision || undefined
                }
                data-highlighted={
                  item.revision === highlightedRevision || undefined
                }
                data-revision-node={item.revision}
                onClick={() => {
                  setSelectedRevision(item.revision)
                  if (
                    window.matchMedia(`(max-width: ${BREAKPOINTS.compact}px)`)
                      .matches
                  ) {
                    requestAnimationFrame(() => {
                      selectionRef.current?.scrollIntoView({ block: 'nearest' })
                      selectionRef.current?.focus({ preventScroll: true })
                    })
                  }
                }}
                onAnimationEnd={(event) => {
                  if (
                    event.currentTarget === event.target &&
                    item.revision === highlightedRevision
                  )
                    onHighlightEnd()
                }}
              >
                <strong>
                  {t('revisionReference', { revision: String(item.revision) })}
                </strong>
                <span>
                  {item.source.kind === 'learning'
                    ? t('sourceLearning')
                    : item.source.kind === 'reorganization'
                      ? t('sourceReorganization')
                      : t('sourceManual')}
                  {activeRevision !== undefined &&
                  item.revision === activeRevision
                    ? ` · ${t('current')}`
                    : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {selected && (
        <Paper
          ref={selectionRef}
          tabIndex={-1}
          withBorder
          p="sm"
          className="revision-graph-selection"
        >
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600}>
                {t('revisionReference', {
                  revision: String(selected.revision)
                })}
              </Text>
              <Text size="sm" c="var(--muted)">
                {formatDate(selected.created_at, language)} ·{' '}
                {selected.source.kind === 'learning'
                  ? t('sourceLearning')
                  : selected.source.kind === 'reorganization'
                    ? t('sourceReorganization')
                    : t('sourceManual')}
              </Text>
            </div>
            <Group gap="xs" wrap="wrap">
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
              {selected.source.kind !== 'manual' && (
                <>
                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconEye size={ICON_SIZE.sm} />}
                    onClick={() => onViewTrajectory(selected.revision)}
                  >
                    {t('trajectory')}
                  </Button>
                  <MaintenanceReportButton
                    report={selected.source.maintenance_report}
                    onRevealObservation={(extractionId) =>
                      onRevealObservation(selected.revision, extractionId)
                    }
                  />
                </>
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
