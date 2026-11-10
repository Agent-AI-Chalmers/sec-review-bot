import React from 'react'

import { Tooltip } from '@mantine/core'

import type { Run, RunEvent } from '../api.js'
import { useMessages } from '../../../shared/i18n.js'
import type { StateMachine as StateMachineDefinition } from '../state-machines.generated.js'
import { NODE_H, NODE_W, diagramGeometry } from './state-machine-geometry.js'
import type { DiagrammedAxis } from './state-machine-layout.js'
import {
  edgeLabel,
  machineTitle,
  stateDescription,
  stateLabel
} from './transitions.js'

/** The current state of one drawn axis, read from the run. */
function currentState(run: Run, axis: DiagrammedAxis): string {
  switch (axis) {
    case 'preparation':
      return run.preparation.status
    case 'execution':
      return run.execution.status
    case 'publication':
      return run.publication.status
  }
}

/**
 * A hand-laid state machine for one axis. States sit on fixed cells (normal path on top,
 * recovery beneath it, failures at the bottom), the current state is highlighted, edges the run
 * actually took are emphasised, and return edges (retry, replay, resume) are dashed. Every node
 * is a tooltip of the state's description and every edge a tooltip of its transitions.
 */
export function StateMachineDiagram({
  machine,
  run,
  events,
  fit = true
}: {
  machine: StateMachineDefinition & { axis: DiagrammedAxis }
  run: Run
  events: RunEvent[]
  fit?: boolean
}): React.JSX.Element {
  const t = useMessages()
  const [hovered, setHovered] = React.useState<{
    label: string
    x: number
    y: number
  } | null>(null)
  const current = currentState(run, machine.axis)
  const geometry = React.useMemo(() => diagramGeometry(machine), [machine])
  const { viewBox } = geometry

  const traversed = new Set(
    events
      .filter((event) => event.axis === machine.axis)
      .map((event) => `${event.from_status ?? ''}->${event.to_status}`)
  )
  return (
    <div className={fit ? 'state-machine is-fit' : 'state-machine is-actual'}>
      <svg
        className="state-machine-svg"
        width={viewBox.width}
        height={viewBox.height}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
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
        {geometry.edges.map((edge) => {
          const pathKey = `${edge.from}->${edge.to}`
          const className = [
            'state-machine-edge',
            edge.kind === 'self'
              ? 'is-self-loop'
              : edge.kind === 'return'
                ? 'is-revert'
                : '',
            traversed.has(pathKey) ? 'is-traversed' : ''
          ]
            .filter(Boolean)
            .join(' ')
          // One line can stand for several transitions that share a state pair; its tooltip
          // names each of them so no decision is hidden behind another.
          const label = [
            ...new Set(
              edge.transitions.map((transition) =>
                edgeLabel(machine, transition, t)
              )
            )
          ].join(' / ')
          return (
            <g key={pathKey} className={className}>
              <path
                d={edge.d}
                className="state-machine-edge-path"
                markerEnd={`url(#arrow-${machine.axis})`}
              />
              {/*
                A wide transparent stroke is the hover/focus target; hovering or focusing it
                shows the transition name in a positioned label. This avoids the native SVG
                <title> (unreliable in Chrome) and Mantine's portal tooltip (which cannot anchor
                to an SVG path), while keeping the edge itself free of drawn text.
              */}
              <path
                d={edge.d}
                className="state-machine-edge-hit"
                tabIndex={0}
                role="img"
                aria-label={label}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  setHovered({ label, x: event.clientX, y: event.clientY })
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
            </g>
          )
        })}
        {geometry.nodes.map(({ state, center: { x, y } }) => {
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
