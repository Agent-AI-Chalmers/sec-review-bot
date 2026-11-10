// The drawn state machines must stay readable as the contract grows. These tests check the
// produced geometry, not pixels: every state has its own cell, no edge passes through a state it
// does not connect, every declared transition is on some line, and every listed return edge is
// one the contract declares.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NODE_H,
  NODE_W,
  diagramGeometry
} from '../browser/features/runs/detail/state-machine-geometry.js'
import {
  RETURN_EDGES,
  STATE_LAYOUT
} from '../browser/features/runs/detail/state-machine-layout.js'
import { diagrammedMachines } from '../browser/features/runs/detail/transitions.js'

test('every drawn state has its own cell, and no cell names an undeclared state', () => {
  for (const machine of diagrammedMachines()) {
    const layout = STATE_LAYOUT[machine.axis]
    assert.deepStrictEqual(
      Object.keys(layout).sort(),
      [...machine.states].sort(),
      `${machine.axis} layout must place exactly its states`
    )
    const cells = Object.values(layout).map(({ col, row }) => `${col}:${row}`)
    assert.strictEqual(
      new Set(cells).size,
      cells.length,
      `${machine.axis} states must not share a cell`
    )
  }
})

test('every listed return edge is a transition the contract declares', () => {
  for (const machine of diagrammedMachines()) {
    const declared = new Set(
      machine.transitions.map((edge) => `${edge.from}->${edge.to}`)
    )
    for (const edge of RETURN_EDGES[machine.axis])
      assert.ok(
        declared.has(edge),
        `${machine.axis} lists ${edge} as a return edge, but the contract does not declare it`
      )
  }
})

test('every declared transition is drawn on exactly one line', () => {
  for (const machine of diagrammedMachines()) {
    const { edges } = diagramGeometry(machine)
    const drawn = edges.flatMap((edge) => edge.transitions)
    assert.strictEqual(drawn.length, machine.transitions.length)
    const pairs = edges.map((edge) => `${edge.from}->${edge.to}`)
    assert.strictEqual(
      new Set(pairs).size,
      pairs.length,
      `${machine.axis} draws one state pair on more than one line`
    )
  }
})

test('no edge passes through a state it does not connect', () => {
  // An edge hidden under a node reads as if the transition did not exist, which is how
  // `queued -> succeeded` once disappeared behind `running`.
  for (const machine of diagrammedMachines()) {
    const { nodes, edges } = diagramGeometry(machine)
    for (const edge of edges) {
      if (edge.kind === 'self') continue
      for (const node of nodes) {
        if (node.state === edge.from || node.state === edge.to) continue
        const hit = edge.samples.find(
          (point) =>
            Math.abs(point.x - node.center.x) < NODE_W / 2 &&
            Math.abs(point.y - node.center.y) < NODE_H / 2
        )
        assert.strictEqual(
          hit,
          undefined,
          `${machine.axis} ${edge.from}->${edge.to} passes through ${node.state}`
        )
      }
    }
  }
})

test('the view box contains every node and edge', () => {
  for (const machine of diagrammedMachines()) {
    const { nodes, edges, viewBox } = diagramGeometry(machine)
    const inside = (x: number, y: number): boolean =>
      x >= viewBox.x &&
      y >= viewBox.y &&
      x <= viewBox.x + viewBox.width &&
      y <= viewBox.y + viewBox.height
    for (const node of nodes)
      assert.ok(
        inside(node.center.x - NODE_W / 2, node.center.y - NODE_H / 2) &&
          inside(node.center.x + NODE_W / 2, node.center.y + NODE_H / 2),
        `${machine.axis}.${node.state} is clipped`
      )
    for (const edge of edges)
      for (const point of edge.samples)
        assert.ok(
          inside(point.x, point.y),
          `${machine.axis} ${edge.from}->${edge.to} is clipped`
        )
  }
})
