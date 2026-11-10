// Pure geometry for the state-machine diagram: where each state sits and the path of each edge.
//
// Kept apart from the React component so the drawing rules that matter to a reader (no edge runs
// through a node it does not touch, one line per state pair, a return edge never hides under its
// forward twin) can be tested on the produced paths instead of on screenshots.
import type { StateMachine } from '../state-machines.generated.js'
import {
  STATE_LAYOUT,
  isReturnEdge,
  selfLoopSide,
  type DiagrammedAxis
} from './state-machine-layout.js'

export const NODE_W = 118
export const NODE_H = 32
const COL_GAP = 58
const ROW_GAP = 56
const PAD = 14
/** Clearance kept between a curve and any node it does not connect. */
const NODE_MARGIN = 6

export interface Point {
  x: number
  y: number
}

export interface DiagramNode {
  state: string
  center: Point
}

export interface DiagramEdge {
  from: string
  to: string
  /** Every declared transition this line stands for. Transitions that share a state pair and
   * differ only by `reason` are one line, because separate lines would lie exactly on top of
   * each other. */
  transitions: StateMachine['transitions']
  kind: 'forward' | 'return' | 'self'
  d: string
  /** Sampled points along the path, for hit tests and bounds. */
  samples: Point[]
}

export interface DiagramGeometry {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  viewBox: { x: number; y: number; width: number; height: number }
}

function cellCenter(col: number, row: number): Point {
  return {
    x: col * (NODE_W + COL_GAP) + NODE_W / 2,
    y: row * (NODE_H + ROW_GAP) + NODE_H / 2
  }
}

/** Where a ray from a node's centre towards `toward` leaves the node's rectangle. */
function boundaryPoint(center: Point, toward: Point, gap: number): Point {
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  if (dx === 0 && dy === 0) return center
  const scale = Math.min(
    dx === 0 ? Infinity : (NODE_W / 2 + gap) / Math.abs(dx),
    dy === 0 ? Infinity : (NODE_H / 2 + gap) / Math.abs(dy)
  )
  return { x: center.x + dx * scale, y: center.y + dy * scale }
}

function quadraticSamples(p0: Point, c: Point, p1: Point): Point[] {
  const points: Point[] = []
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const e = t * t
    points.push({
      x: a * p0.x + b * c.x + e * p1.x,
      y: a * p0.y + b * c.y + e * p1.y
    })
  }
  return points
}

function insideNode(point: Point, center: Point, margin: number): boolean {
  return (
    Math.abs(point.x - center.x) < NODE_W / 2 + margin &&
    Math.abs(point.y - center.y) < NODE_H / 2 + margin
  )
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** A curve between two different states. `bend` pushes the control point to the left of the
 * direction of travel, so an edge and its reverse bow to opposite sides and never overlap. */
function curve(
  from: Point,
  to: Point,
  bend: number
): { d: string; samples: Point[] } {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  // Left of travel in screen coordinates (y grows downwards).
  const normal = { x: dy / length, y: -dx / length }
  const control = { x: mid.x + normal.x * bend, y: mid.y + normal.y * bend }
  const start = boundaryPoint(from, control, 0)
  const end = boundaryPoint(to, control, 2)
  // The control point is doubled away from the chord's midpoint so the curve's own apex, which
  // a quadratic reaches only halfway to its control point, sits `bend` away from the chord.
  const chordMid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const apexControl = {
    x: chordMid.x + (control.x - chordMid.x) * 2,
    y: chordMid.y + (control.y - chordMid.y) * 2
  }
  const c = bend === 0 ? chordMid : apexControl
  return {
    d:
      bend === 0
        ? `M${round(start.x)},${round(start.y)} L${round(end.x)},${round(end.y)}`
        : `M${round(start.x)},${round(start.y)} Q${round(c.x)},${round(c.y)} ${round(end.x)},${round(end.y)}`,
    samples: quadraticSamples(start, c, end)
  }
}

/** A small loop on one edge of a node, off-centre so it stays clear of edges meeting the node's
 * middle. */
function selfLoop(
  center: Point,
  side: 'above' | 'below'
): { d: string; samples: Point[] } {
  const direction = side === 'below' ? 1 : -1
  const anchorX = center.x + NODE_W / 2 - 26
  const y = center.y + (direction * NODE_H) / 2
  const sx = anchorX - 10
  const ex = anchorX + 10
  const apex = y + 20 * direction
  return {
    d:
      `M${sx},${y} ` +
      `C${sx - 8},${apex} ${anchorX - 8},${apex} ${anchorX},${apex} ` +
      `C${anchorX + 8},${apex} ${ex + 8},${apex} ${ex},${y}`,
    samples: [
      { x: sx - 8, y: apex },
      { x: anchorX, y: apex },
      { x: ex + 8, y: apex }
    ]
  }
}

/** Lay out one diagrammed machine. Throws when a state has no cell, so a contract change that
 * adds a state is caught by the layout test rather than drawn at an arbitrary position. */
export function diagramGeometry(
  machine: StateMachine & { axis: DiagrammedAxis }
): DiagramGeometry {
  const layout = STATE_LAYOUT[machine.axis]
  const centers = new Map<string, Point>()
  for (const state of machine.states) {
    const cell = layout[state]
    if (cell === undefined)
      throw new Error(`${machine.axis}.${state} has no diagram cell`)
    centers.set(state, cellCenter(cell.col, cell.row))
  }
  const nodes = machine.states.map((state) => ({
    state,
    center: centers.get(state) as Point
  }))

  const groups = new Map<string, StateMachine['transitions']>()
  for (const transition of machine.transitions) {
    const key = `${transition.from}->${transition.to}`
    groups.set(key, [...(groups.get(key) ?? []), transition])
  }

  const edges: DiagramEdge[] = []
  for (const [key, transitions] of groups) {
    const [first] = transitions
    if (first === undefined) continue
    const { from, to } = first
    const fromCenter = centers.get(from) as Point
    const toCenter = centers.get(to) as Point
    if (from === to) {
      edges.push({
        from,
        to,
        transitions,
        kind: 'self',
        ...selfLoop(fromCenter, selfLoopSide(machine.axis, from))
      })
      continue
    }
    const kind = isReturnEdge(machine.axis, from, to) ? 'return' : 'forward'
    const others = nodes.filter(
      (node) => node.state !== from && node.state !== to
    )
    const blocked = (samples: Point[]): boolean =>
      samples.some((point) =>
        others.some((node) => insideNode(point, node.center, NODE_MARGIN))
      )
    // Straight when nothing is in the way and no reverse edge shares the chord; otherwise bend,
    // widening until the curve clears every other node.
    const twin = groups.has(`${to}->${from}`)
    const start = twin ? 16 : 0
    let chosen = curve(fromCenter, toCenter, start)
    if (blocked(chosen.samples)) {
      const candidates: number[] = []
      for (let bend = Math.max(start, 24); bend <= 120; bend += 16)
        candidates.push(bend, ...(twin ? [] : [-bend]))
      for (const bend of candidates) {
        const attempt = curve(fromCenter, toCenter, bend)
        chosen = attempt
        if (!blocked(attempt.samples)) break
      }
    }
    edges.push({ from, to, transitions, kind, ...chosen })
    void key
  }

  const xs: number[] = []
  const ys: number[] = []
  for (const node of nodes) {
    xs.push(node.center.x - NODE_W / 2, node.center.x + NODE_W / 2)
    ys.push(node.center.y - NODE_H / 2, node.center.y + NODE_H / 2)
  }
  for (const edge of edges)
    for (const point of edge.samples) {
      xs.push(point.x)
      ys.push(point.y)
    }
  const minX = Math.min(...xs) - PAD
  const minY = Math.min(...ys) - PAD
  return {
    nodes,
    edges,
    viewBox: {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(Math.max(...xs) + PAD - minX),
      height: Math.ceil(Math.max(...ys) + PAD - minY)
    }
  }
}
