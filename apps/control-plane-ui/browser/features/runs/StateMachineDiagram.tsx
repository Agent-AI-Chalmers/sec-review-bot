import React from 'react'

import { Tooltip } from '@mantine/core'

import type { Run, RunEvent } from './api.js'
import { useMessages } from '../../shared/i18n.js'
import type {
  StateAxis,
  StateMachine as StateMachineDefinition
} from './state-machines.generated.js'
import {
  STATE_LAYOUT,
  revertSide,
  selfLoopSide
} from './state-machine-layout.js'
import {
  edgeLabel,
  machineTitle,
  stateDescription,
  stateLabel
} from './transitions.js'

/** The current state of one axis, read from the run. */
function currentState(run: Run, axis: StateAxis): string | null {
  if (axis === 'execution') return run.execution.status
  if (axis === 'publication') return run.publication.status
  return run.preparation.status
}

/** Column each state sits in: the longest simple path from the initial state, ignoring edges
 * that close a loop, so a retry/replay never pushes a state ever further right. */
function stateColumns(machine: StateMachineDefinition): Map<string, number> {
  const column = new Map<string, number>([[machine.initial, 0]])
  const visit = (state: string, depth: number, path: Set<string>): void => {
    for (const edge of machine.transitions) {
      if (edge.from !== state) continue
      if (path.has(edge.to)) continue
      const candidate = depth + 1
      const existing = column.get(edge.to)
      if (existing === undefined || candidate > existing) {
        column.set(edge.to, candidate)
        const nextPath = new Set(path)
        nextPath.add(edge.to)
        visit(edge.to, candidate, nextPath)
      }
    }
  }
  visit(machine.initial, 0, new Set([machine.initial]))
  for (const state of machine.states)
    if (!column.has(state)) column.set(state, 0)
  return column
}

/** The states on the longest forward (non-reverting) chain from the initial state. These stay
 * on the top row; everything else is a side branch placed below. */
function longestForwardPath(
  machine: StateMachineDefinition,
  columns: Map<string, number>
): Set<string> {
  const forward = machine.transitions.filter(
    (edge) => !isReverting(columns, edge.from, edge.to)
  )
  // Longest forward path length from each state to a terminal, memoised with cycle protection.
  const memo = new Map<string, number>()
  const terminal = new Set(machine.terminal)
  const remaining = (state: string, seen: Set<string>): number => {
    const cached = memo.get(state)
    if (cached !== undefined) return cached
    if (seen.has(state)) return 0
    const next = new Set(seen).add(state)
    let best = terminal.has(state) ? 0 : -1
    for (const edge of forward) {
      if (edge.from !== state) continue
      const candidate = remaining(edge.to, next) + 1
      if (candidate > best) best = candidate
    }
    memo.set(state, best)
    return best
  }
  // Follow the chain that maximises remaining forward steps, so the main row is the path to a
  // terminal rather than a detour into a failure branch.
  const path = new Set<string>([machine.initial])
  let current = machine.initial
  for (;;) {
    const options = forward
      .filter((edge) => edge.from === current && !path.has(edge.to))
      .map((edge) => ({ edge, score: remaining(edge.to, new Set()) }))
      .sort((left, right) => right.score - left.score)
    const next = options[0]
    if (next === undefined || next.score < 0) break
    path.add(next.edge.to)
    current = next.edge.to
  }
  return path
}

/** Whether an edge points back to a state strictly before its source, i.e. it closes a loop
 * between two different nodes. A self-edge (`from === to`) is not a reverting edge: it has its
 * own arc geometry, and treating it as a back-edge would let it pull its own node around. */
function isReverting(
  columns: Map<string, number>,
  from: string,
  to: string
): boolean {
  if (from === to) return false
  return (columns.get(to) ?? 0) <= (columns.get(from) ?? 0)
}

/** Straight edge between two nodes on the same (or different) row, label above the midpoint. */
function forwardGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number }
): { d: string; labelAt: { x: number; y: number } } {
  const sx = from.x + NODE_W / 2
  const tx = to.x - NODE_W / 2
  const sameRow = from.y === to.y
  return {
    d: `M${sx},${from.y} L${tx},${to.y}`,
    labelAt: sameRow
      ? { x: (sx + tx) / 2, y: from.y - 6 }
      : { x: (sx + tx) / 2, y: (from.y + to.y) / 2 - 4 }
  }
}

/** A short quadratic between two nodes for a reverting edge. It bulges down when the edge runs
 * leftwards along a row, and along the shorter side otherwise, so a loop stays close to the
 * nodes it connects instead of spanning the whole diagram. */
function revertGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  side: 'above' | 'below'
): { d: string; labelAt: { x: number; y: number } } {
  if (from.y === to.y) {
    const offset = NODE_H / 2 + 24
    const cx = (from.x + to.x) / 2
    if (side === 'above') {
      const sy = from.y - NODE_H / 2
      const ty = to.y - NODE_H / 2
      const cy = Math.min(sy, ty) - offset
      return {
        d: `M${from.x},${sy} Q${cx},${cy} ${to.x},${ty}`,
        labelAt: { x: cx, y: cy + 10 }
      }
    }
    const sy = from.y + NODE_H / 2
    const ty = to.y + NODE_H / 2
    const cy = Math.max(sy, ty) + offset
    return {
      d: `M${from.x},${sy} Q${cx},${cy} ${to.x},${ty}`,
      labelAt: { x: cx, y: cy - 6 }
    }
  }
  const down = to.y > from.y
  const sy = from.y + (down ? NODE_H / 2 : -NODE_H / 2)
  const ty = to.y + (down ? -NODE_H / 2 : NODE_H / 2)
  const cx = (from.x + to.x) / 2 + 12
  const cy = (sy + ty) / 2
  return {
    d: `M${from.x},${sy} Q${cx},${cy} ${to.x},${ty}`,
    labelAt: { x: cx + 4, y: cy }
  }
}

/** A self-loop: an edge from a state back to itself, drawn as a small arc hugging the node.
 *
 * A self-loop has one node, so the two-node geometry cannot describe it: `from` and `to` are the
 * same point and a quadratic through them collapses into a line sitting on the node's own edge.
 * Instead the path leaves one edge of the node off-centre, bows outward and comes back onto the
 * same edge, with the arrowhead pointing back into the node.
 *
 * The arc faces away from the diagram's occupied rows: `side` is chosen by the caller from the
 * node's position. A node on the bottom row loops downward into empty space, while a node with a
 * branch row beneath it loops upward, because a downward arc there would cut through the sibling
 * nodes and the edges crossing to them.
 */
function selfLoopGeometry(
  from: { x: number; y: number },
  side: 'above' | 'below'
): {
  d: string
  labelAt: { x: number; y: number }
} {
  // Anchor the two ends on the node's facing edge, straddling the centre so the loop is symmetric.
  const half = 14
  const sx = from.x - half
  const ex = from.x + half
  const direction = side === 'below' ? 1 : -1
  const y = from.y + (direction * NODE_H) / 2
  // Keep the arc within the space reserved above/below the grid so it never clips.
  const bulge = 18 * direction
  const apex = y + bulge
  // Two cubic segments meeting at the arc's apex give a round, even loop. Both control points
  // pull outward on the chosen side, so the widest point clears the node's edge.
  const d =
    `M${sx},${y} ` +
    `C${sx - 10},${apex} ${from.x - 10},${apex} ${from.x},${apex} ` +
    `C${from.x + 10},${apex} ${ex + 10},${apex} ${ex},${y}`
  return { d, labelAt: { x: from.x, y: apex + 4 * direction } }
}

const NODE_W = 118
const NODE_H = 32
const COL_GAP = 46
const ROW_GAP = 52
const PAD = 12

/**
 * A hand-laid state machine for one axis: states in lifecycle columns, the current state
 * highlighted, traversed edges emphasised, and reverting edges drawn as arcs above the row so
 * the forward flow stays clean. Every node is a tooltip of the state's description.
 */
export function StateMachineDiagram({
  machine,
  run,
  events,
  fit = true
}: {
  machine: StateMachineDefinition
  run: Run
  events: RunEvent[]
  fit?: boolean
}): React.JSX.Element | null {
  const t = useMessages()
  const current = currentState(run, machine.axis)
  if (current === null) return null

  const [hovered, setHovered] = React.useState<{
    label: string
    x: number
    y: number
  } | null>(null)

  const columns = stateColumns(machine)
  // States that only feed a long back-edge (e.g. uncertain -> queued) are pulled under their
  // loop target, so the loop is a short arc rather than one spanning the whole diagram. This
  // runs over a copy of the columns; the forward-layer order is unchanged for everything else.
  for (const edge of machine.transitions) {
    if (!isReverting(columns, edge.from, edge.to)) continue
    const fromCol = columns.get(edge.from) ?? 0
    const toCol = columns.get(edge.to) ?? 0
    // A long back-edge (jumping more than one column) indicates a loop-back state that reads
    // better tucked next to its target.
    if (fromCol - toCol > 1) columns.set(edge.from, toCol + 1)
  }

  // Rows: the longest forward chain from the initial state is the main row (row 0); every state
  // that is a side branch (a failure, a skip, a recovery) sits on row 1 beneath it, so the
  // loops between those states stay short and the main path stays a straight line.
  const mainPath = longestForwardPath(machine, columns)
  const rows = new Map<string, number>()
  for (const state of machine.states)
    rows.set(state, mainPath.has(state) ? 0 : 1)
  // A UI-side layout override places a state on an explicit cell where the computed grid would
  // misplace a branch (e.g. execution `failed` under `running`). This is drawing, not
  // contract, so it lives in `state-machine-layout.ts`.
  const overrides = STATE_LAYOUT[machine.axis] ?? {}
  for (const state of machine.states) {
    const position = overrides[state]
    if (position?.col !== undefined) columns.set(state, position.col)
    if (position?.row !== undefined) rows.set(state, position.row)
  }

  // Nodes sharing a (column,row) cell get bumped down so they never overlap.
  const used = new Set<string>()
  for (const state of machine.states) {
    let row = rows.get(state) ?? 0
    while (used.has(`${columns.get(state) ?? 0}:${row}`)) row += 1
    used.add(`${columns.get(state) ?? 0}:${row}`)
    rows.set(state, row)
  }
  const maxColumn = Math.max(...columns.values())
  const maxRows = Math.max(...rows.values()) + 1
  const width = PAD * 2 + (maxColumn + 1) * NODE_W + maxColumn * COL_GAP
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP
  // Room above and below for short loop arcs that bulge outside the node rows.
  const arcSpace = 30
  const aboveSpace = arcSpace
  const belowSpace = arcSpace
  const viewHeight = height + aboveSpace + belowSpace
  const rowTop = aboveSpace

  const center = (state: string): { x: number; y: number } => {
    const col = columns.get(state) ?? 0
    const row = rows.get(state) ?? 0
    return {
      x: PAD + col * (NODE_W + COL_GAP) + NODE_W / 2,
      y: rowTop + PAD + row * (NODE_H + ROW_GAP) + NODE_H / 2
    }
  }

  const traversed = new Set(
    events
      .filter((event) => event.axis === machine.axis)
      .map((event) => `${event.from_status ?? ''}->${event.to_status}`)
  )
  return (
    <div className={fit ? 'state-machine is-fit' : 'state-machine is-actual'}>
      <svg
        className="state-machine-svg"
        width={width}
        height={viewHeight}
        viewBox={`0 0 ${width} ${viewHeight}`}
        role="group"
        aria-label={machineTitle(machine, t)}
        onPointerDown={() => setHovered(null)}
      >
        <defs>
          <marker
            id={`arrow-${machine.axis}`}
            markerWidth="9"
            markerHeight="7"
            refX="8"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L9,3.5 L0,7 Z" fill="currentColor" />
          </marker>
        </defs>
        {machine.transitions.map((edge, index) => {
          const from = center(edge.from)
          const to = center(edge.to)
          const pathKey = `${edge.from}->${edge.to}`
          const key = `${pathKey}:${edge.reason ?? ''}:${edge.label ?? ''}:${index}`
          const emphasised = traversed.has(pathKey)
          const selfLoop = edge.from === edge.to
          const revert = isReverting(columns, edge.from, edge.to)
          const className = [
            'state-machine-edge',
            selfLoop ? 'is-self-loop' : revert ? 'is-revert' : '',
            emphasised ? 'is-traversed' : ''
          ]
            .filter(Boolean)
            .join(' ')

          // A self-loop needs its own arc: the two-node geometries put both ends at the same
          // point and collapse into a line on the node's own edge. Layout can override the
          // otherwise geometric choice for an edge whose semantic grouping reads better on one
          // side of its node.
          const { d } = selfLoop
            ? selfLoopGeometry(
                from,
                selfLoopSide(
                  machine.axis,
                  edge.from,
                  (rows.get(edge.from) ?? 0) === maxRows - 1 ? 'below' : 'above'
                )
              )
            : revert
              ? revertGeometry(
                  from,
                  to,
                  revertSide(machine.axis, edge.from, edge.to)
                )
              : forwardGeometry(from, to)

          const label = edgeLabel(machine, edge, t)
          return (
            <g key={key} className={className}>
              <path
                d={d}
                className="state-machine-edge-path"
                markerEnd={`url(#arrow-${machine.axis})`}
              />
              {/*
                The transition name is a hover/focus tooltip rather than drawn text, so the
                edge keeps its clean shape. Mantine's tooltip is used instead of the native SVG
                <title>, which Chrome renders unreliably inside a transformed, nested SVG. The
                invisible wide stroke is the hover/focus target.
              */}
              {
                // A wide transparent stroke is the hover/focus target; hovering or focusing it
                // shows the transition name in a positioned label. This avoids the native SVG
                // <title> (unreliable in Chrome) and Mantine's portal tooltip (which cannot
                // anchor to an SVG path), while keeping the edge itself free of drawn text.
                <path
                  d={d}
                  className="state-machine-edge-hit"
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    setHovered({
                      label,
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                  onMouseEnter={(event) =>
                    setHovered({ label, x: event.clientX, y: event.clientY })
                  }
                  onMouseMove={(event) =>
                    setHovered({ label, x: event.clientX, y: event.clientY })
                  }
                  onMouseLeave={() => setHovered(null)}
                  onFocus={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setHovered({
                      label,
                      x: rect.x + rect.width / 2,
                      y: rect.y
                    })
                  }}
                  onBlur={() => setHovered(null)}
                />
              }
            </g>
          )
        })}
        {machine.states.map((state) => {
          const { x, y } = center(state)
          const isCurrent = state === current
          const className = [
            'state-machine-node',
            isCurrent ? 'is-current' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <g key={state} className={className}>
              <Tooltip
                label={stateDescription(machine, state, t)}
                multiline
                w={260}
                withArrow
                position="top"
              >
                <g
                  tabIndex={0}
                  role="img"
                  aria-label={stateLabel(machine, state, t)}
                >
                  <rect
                    x={x - NODE_W / 2}
                    y={y - NODE_H / 2}
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                  />
                  <text
                    x={x}
                    y={y}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {stateLabel(machine, state, t)}
                  </text>
                </g>
              </Tooltip>
            </g>
          )
        })}
      </svg>
      {hovered !== null && (
        <span
          className="state-machine-edge-tip"
          style={{ left: hovered.x, top: hovered.y }}
          role="tooltip"
        >
          {hovered.label}
        </span>
      )}
    </div>
  )
}
