// Presentation-only layout for the state-machine diagrams.
//
// Column/row positions and which side a loop arc bulges on are how the diagram is drawn, not
// part of the coordination contract: they say nothing about which transitions exist or what a
// state means. They live here, next to the component that draws them, so `openapi.yaml` stays a
// description of the API rather than of the console's pixel layout.
//
// Anything not listed falls back to the component's computed grid (forward-flow layering with
// side branches on the row below).
import type { StateAxis } from './state-machines.generated.js'

/** Which axes the console draws, in lifecycle order. The failure-notice outbox (`notice`) is a
 * real state machine and is declared in the contract, but it is not a run lifecycle axis, so the
 * figure leaves it out. This is a presentation choice and lives here rather than in the contract. */
export const DIAGRAMMED_AXES = [
  'preparation',
  'execution',
  'publication'
] as const satisfies readonly StateAxis[]

export interface StatePosition {
  col?: number
  row?: number
}

/** Per-axis overrides of the computed node grid. */
export const STATE_LAYOUT: Partial<
  Record<StateAxis, Record<string, StatePosition>>
> = {
  preparation: {
    pending: { col: 0 },
    preparing: { col: 1 },
    submitted: { col: 2 },
    failed: { col: 1, row: 1 }
  },
  execution: {
    // Main path along row 0; the failure/uncertain/recovery branch on row 1 beneath it.
    pending: { col: 0, row: 0 },
    queued: { col: 1, row: 0 },
    running: { col: 2, row: 0 },
    succeeded: { col: 3, row: 0 },
    skipped: { col: 0, row: 1 },
    uncertain: { col: 1, row: 1 },
    failed: { col: 2, row: 1 }
  },
  publication: {
    pending: { col: 0 },
    publishing: { col: 1 },
    published: { col: 2 },
    skipped: { col: 0, row: 1 },
    failed: { col: 1, row: 1 }
  }
}

/** Which side a reverting (loop) edge bulges on, keyed `axis:from->to`. Default is below. */
export const REVERT_SIDE: Record<string, 'above' | 'below'> = {
  'preparation:preparing->pending': 'above',
  'publication:publishing->pending': 'above'
}

export function revertSide(
  axis: StateAxis,
  from: string,
  to: string
): 'above' | 'below' {
  return REVERT_SIDE[`${axis}:${from}->${to}`] ?? 'below'
}
