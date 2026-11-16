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
import type { MemoryTreeVersion } from './api-types.generated.js'
import { MaintenanceReportButton } from './MaintenanceReport.js'
import { BREAKPOINTS, ICON_SIZE } from '../../shared/design.js'

export type VersionGraphItem = MemoryTreeVersion

interface PositionedVersion extends VersionGraphItem {
  x: number
  y: number
}

const NODE_WIDTH = 184
const NODE_HEIGHT = 72
const COLUMN_GAP = 56
const ROW_GAP = 54
const PADDING = 24

function layoutVersions(versions: VersionGraphItem[]): {
  nodes: PositionedVersion[]
  width: number
  height: number
} {
  const items = new Map(versions.map((item) => [item.version, item]))
  const children = new Map<number, VersionGraphItem[]>()
  for (const item of versions) {
    if (
      item.predecessor_version === null ||
      !items.has(item.predecessor_version)
    )
      continue
    const siblings = children.get(item.predecessor_version) ?? []
    siblings.push(item)
    children.set(item.predecessor_version, siblings)
  }
  for (const siblings of children.values())
    siblings.sort((left, right) => left.version - right.version)

  const roots = versions
    .filter(
      (item) =>
        item.predecessor_version === null ||
        !items.has(item.predecessor_version)
    )
    .sort((left, right) => left.version - right.version)
  const xByVersion = new Map<number, number>()
  const visited = new Set<number>()
  let nextLeaf = 0
  const place = (item: VersionGraphItem): number => {
    if (visited.has(item.version))
      return xByVersion.get(item.version) ?? nextLeaf++
    visited.add(item.version)
    const descendants = children.get(item.version) ?? []
    const x =
      descendants.length === 0
        ? nextLeaf++
        : descendants.reduce((sum, child) => sum + place(child), 0) /
          descendants.length
    xByVersion.set(item.version, x)
    return x
  }
  roots.forEach(place)
  versions
    .filter((item) => !visited.has(item.version))
    .sort((left, right) => left.version - right.version)
    .forEach(place)

  const newestFirst = versions.toSorted(
    (left, right) => right.version - left.version
  )
  const yByVersion = new Map(
    newestFirst.map((item, index) => [
      item.version,
      PADDING + index * (NODE_HEIGHT + ROW_GAP)
    ])
  )
  const laneCount = Math.max(1, Math.ceil(nextLeaf))
  return {
    nodes: versions.map((item) => ({
      ...item,
      x:
        PADDING +
        (xByVersion.get(item.version) ?? 0) * (NODE_WIDTH + COLUMN_GAP),
      y: yByVersion.get(item.version) ?? PADDING
    })),
    width: PADDING * 2 + laneCount * NODE_WIDTH + (laneCount - 1) * COLUMN_GAP,
    height:
      PADDING * 2 +
      newestFirst.length * NODE_HEIGHT +
      Math.max(0, newestFirst.length - 1) * ROW_GAP
  }
}

export function VersionGraph({
  versions,
  windowHelp,
  historical,
  onShowLatest,
  activeVersion,
  onViewFiles,
  onViewTrajectory,
  onRevealObservation,
  onCompare,
  onSetCurrent,
  allowSetCurrent,
  highlightedVersion,
  focusVersion,
  onHighlightEnd
}: {
  versions: VersionGraphItem[]
  windowHelp: string
  historical: boolean
  onShowLatest: (() => void) | undefined
  activeVersion: number | undefined
  onViewFiles: (version: number) => void
  onViewTrajectory: (version: number) => void
  onRevealObservation: (version: number, extractionId: string) => void
  onCompare: (version: VersionGraphItem) => void
  onSetCurrent: (version: number) => void
  allowSetCurrent: boolean
  focusVersion?: number | undefined
  highlightedVersion: number | undefined
  onHighlightEnd: () => void
}): React.JSX.Element {
  const t = useMessages()
  const { language } = useLanguage()
  const [selectedVersion, setSelectedVersion] = React.useState(
    activeVersion ?? 0
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
    if (activeVersion !== undefined) setSelectedVersion(activeVersion)
  }, [activeVersion])
  const layout = React.useMemo(() => layoutVersions(versions), [versions])
  const nodes = new Map(layout.nodes.map((item) => [item.version, item]))
  const activeLineage = new Set<number>()
  let lineageCursor =
    activeVersion === undefined ? undefined : nodes.get(activeVersion)
  while (lineageCursor && !activeLineage.has(lineageCursor.version)) {
    activeLineage.add(lineageCursor.version)
    lineageCursor =
      lineageCursor.predecessor_version === null
        ? undefined
        : nodes.get(lineageCursor.predecessor_version)
  }
  const selected = nodes.get(selectedVersion) ?? layout.nodes[0]

  const positioned = React.useRef<string | undefined>(undefined)
  const navigationTarget = highlightedVersion ?? focusVersion
  const requestedPosition =
    navigationTarget === undefined ? 'latest' : `version:${navigationTarget}`
  React.useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (!viewport || layout.nodes.length === 0) return
    // Refreshes replace the rows, but only an explicit navigation changes the
    // requested position. Preserve the reader's pan/scroll through data updates.
    if (positioned.current === requestedPosition) return
    const target = layout.nodes.find(
      (item) => item.version === navigationTarget
    )
    if (navigationTarget !== undefined && !target) return
    positioned.current = requestedPosition
    const current =
      target ?? layout.nodes.find((item) => item.version === activeVersion)
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
      setSelectedVersion(target.version)
      viewport
        .querySelector<HTMLElement>(`[data-version-node="${target.version}"]`)
        ?.focus({ preventScroll: true })
    }
  }, [requestedPosition, navigationTarget, layout.nodes, activeVersion])

  const versionNumbers = versions.map((item) => item.version)
  const rangeStart = versionNumbers.length
    ? String(Math.min(...versionNumbers))
    : '—'
  const rangeEnd = versionNumbers.length
    ? String(Math.max(...versionNumbers))
    : '—'

  return (
    <div className="version-graph-section">
      <div className="version-graph-frame">
        <Group
          className="version-graph-toolbar"
          justify="space-between"
          gap="xs"
        >
          <Group gap="xs">
            <Text size="sm" c="var(--muted)">
              {t('versionGraphRange', { from: rangeStart, to: rangeEnd })}
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
            {t('versionGraphLatest')}
          </Button>
        </Group>
        <div
          ref={scrollRef}
          className="version-graph-scroll"
          data-panning={panning || undefined}
          role="region"
          aria-label={t('versionGraph')}
          tabIndex={0}
          onPointerDown={(event) => {
            if (
              event.pointerType !== 'mouse' ||
              event.button !== 0 ||
              (event.target as HTMLElement).closest('.version-graph-node')
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
            className="version-graph"
            style={{ width: layout.width, height: layout.height }}
          >
            <svg
              className="version-graph-edges"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.nodes.map((item) => {
                if (item.predecessor_version === null) return null
                const predecessor = nodes.get(item.predecessor_version)
                if (!predecessor) return null
                const startX = item.x + NODE_WIDTH / 2
                const startY = item.y + NODE_HEIGHT
                const endX = predecessor.x + NODE_WIDTH / 2
                const endY = predecessor.y
                const middleY = startY + (endY - startY) / 2
                return (
                  <path
                    key={`${item.version}-${predecessor.version}`}
                    d={`M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`}
                    data-active-line={
                      activeLineage.has(item.version) &&
                      activeLineage.has(predecessor.version)
                        ? 'true'
                        : undefined
                    }
                  />
                )
              })}
            </svg>
            {layout.nodes.map((item) => (
              <button
                key={item.version}
                type="button"
                className="version-graph-node"
                style={{
                  left: item.x,
                  top: item.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT
                }}
                data-current={
                  activeVersion !== undefined && item.version === activeVersion
                    ? true
                    : undefined
                }
                data-selected={item.version === selected?.version || undefined}
                data-highlighted={
                  item.version === highlightedVersion || undefined
                }
                data-version-node={item.version}
                onClick={() => {
                  setSelectedVersion(item.version)
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
                    item.version === highlightedVersion
                  )
                    onHighlightEnd()
                }}
              >
                <strong>
                  {t('versionReference', { version: String(item.version) })}
                </strong>
                <span>
                  {item.source.kind === 'learning'
                    ? t('sourceLearning')
                    : item.source.kind === 'reorganization'
                      ? t('sourceReorganization')
                      : t('sourceManual')}
                  {activeVersion !== undefined && item.version === activeVersion
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
          className="version-graph-selection"
        >
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600}>
                {t('versionReference', {
                  version: String(selected.version)
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
                onClick={() => onViewFiles(selected.version)}
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
                    onClick={() => onViewTrajectory(selected.version)}
                  >
                    {t('trajectory')}
                  </Button>
                  <MaintenanceReportButton
                    report={selected.source.maintenance_report}
                    onRevealObservation={(extractionId) =>
                      onRevealObservation(selected.version, extractionId)
                    }
                  />
                </>
              )}
              {activeVersion !== undefined &&
              selected.version === activeVersion ? (
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
                  onClick={() => onSetCurrent(selected.version)}
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
