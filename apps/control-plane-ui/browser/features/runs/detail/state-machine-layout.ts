// Presentation-only layout for the state-machine diagrams.
//
// Cell positions are how the diagram is drawn, not part of the coordination contract: they say
// nothing about which transitions exist or what a state means. They live here, next to the
// component that draws them, so `openapi.yaml` stays a description of the API rather than of the
// console's pixel layout.
//
// Every drawn axis places every state explicitly. A computed grid cannot know which path is the
// normal one, and a state added to the contract without a cell here would otherwise land
// wherever a heuristic put it; `test/state-machine-layout.test.ts` fails instead.
import type { StateAxis } from '../state-machines.generated.js'

/** Which lifecycle axes the console draws, in lifecycle order. */
export const DIAGRAMMED_AXES = [
  'preparation',
  'execution',
  'publication'
] as const satisfies readonly StateAxis[]

export type DiagrammedAxis = (typeof DIAGRAMMED_AXES)[number]

export interface StatePosition {
  col: number
  row: number
}

/**
 * One cell per state. Row 0 is the normal path from the initial state to the successful
 * terminal state, read left to right. Row 1 holds the recovery states (`uncertain`,
 * `disconnected`) beneath the step they recover, and row 2 the failure and skip outcomes.
 * Keeping each kind of state on its own row is what lets an edge's direction carry meaning:
 * right is progress, down is trouble, up is recovery.
 */
export const STATE_LAYOUT: Record<
  DiagrammedAxis,
  Record<string, StatePosition>
> = {
  preparation: {
    pending: { col: 0, row: 0 },
    preparing: { col: 1, row: 0 },
    submitted: { col: 2, row: 0 },
    uncertain: { col: 1, row: 1 },
    disconnected: { col: 2, row: 1 },
    failed: { col: 2, row: 2 }
  },
  execution: {
    pending: { col: 0, row: 0 },
    queued: { col: 1, row: 0 },
    running: { col: 2, row: 0 },
    succeeded: { col: 3, row: 0 },
    uncertain: { col: 1, row: 1 },
    disconnected: { col: 2, row: 1 },
    skipped: { col: 0, row: 2 },
    failed: { col: 2, row: 2 }
  },
  publication: {
    pending: { col: 0, row: 0 },
    publishing: { col: 1, row: 0 },
    published: { col: 2, row: 0 },
    uncertain: { col: 1, row: 1 },
    disconnected: { col: 2, row: 1 },
    skipped: { col: 0, row: 2 },
    failed: { col: 2, row: 2 }
  }
}

/**
 * Edges that return the run to an earlier point of its lifecycle: a retry, a replay, a
 * reclaim, or an operator resume. These are drawn dashed and arced; every other edge is
 * forward motion, including a move into a failure or recovery state. Keyed `from->to`.
 *
 * This is a statement about meaning, so it is listed rather than inferred from geometry: an
 * edge that happens to point left or up is not a retry by virtue of its direction.
 */
export const RETURN_EDGES: Record<DiagrammedAxis, readonly string[]> = {
  preparation: [
    'preparing->pending',
    'uncertain->preparing',
    'disconnected->uncertain'
  ],
  execution: ['uncertain->queued', 'disconnected->uncertain'],
  publication: [
    'publishing->pending',
    'uncertain->publishing',
    'disconnected->pending'
  ]
}

/** Which side a self-transition loops on, keyed `axis:state`. Default is above. */
export const SELF_LOOP_SIDE: Record<string, 'above' | 'below'> = {
  // Replays keep the submission unconfirmed. The lower arc reads as a retry contained within
  // that branch, and stays clear of the normal pending -> queued path above it.
  'execution:uncertain': 'below'
}

export function isDiagrammedAxis(axis: StateAxis): axis is DiagrammedAxis {
  return (DIAGRAMMED_AXES as readonly string[]).includes(axis)
}

export function isReturnEdge(
  axis: DiagrammedAxis,
  from: string,
  to: string
): boolean {
  return RETURN_EDGES[axis].includes(`${from}->${to}`)
}

export function selfLoopSide(
  axis: StateAxis,
  state: string
): 'above' | 'below' {
  return SELF_LOOP_SIDE[`${axis}:${state}`] ?? 'above'
}
