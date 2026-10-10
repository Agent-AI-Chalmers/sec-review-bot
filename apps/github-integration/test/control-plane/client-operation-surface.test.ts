// The store boundary's operation surface.
//
// `POST /v1/store` dispatches by operation name, and Control Plane refuses any name it does
// not know. Nothing checked that the integration only sends names the Control Plane
// accepts, so this compares the two lists directly.
//
// The client's list is read from its syntax rather than from a constant, because the names
// only exist as the first argument of each `this.call(...)`. That makes the syntax itself
// the policy here: a new method that sends an unknown name fails this test instead of
// failing in production.
//
// Only one direction is asserted. A name the Control Plane accepts but this client never
// sends is legitimate — it may be waiting for another caller — while a name this client
// sends and the Control Plane refuses is always a defect.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { controlPlaneOperations } from '../../../../control-plane/src/index.js'

const CLIENT_SOURCE = fileURLToPath(new URL('../../src/control-plane/client.ts', import.meta.url))

/** The first argument of every `this.call(...)` in the client, read from its syntax. */
function sentOperations(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'call' &&
      // `getText` rather than a node-type guard: the `this` keyword's guard is runtime-only
      // in this TypeScript version and is absent from the published types.
      node.expression.expression.getText(source) === 'this'
    ) {
      const [first] = node.arguments
      if (first !== undefined && ts.isStringLiteral(first)) found.add(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...found].sort()
}

test('every operation the integration sends is one Control Plane accepts', () => {
  const accepted = new Set<string>(controlPlaneOperations)
  const sent = sentOperations(CLIENT_SOURCE)

  assert.ok(sent.length > 0, `Expected to find this.call(...) sites in ${CLIENT_SOURCE}`)
  const refused = sent.filter((operation) => !accepted.has(operation))
  assert.deepEqual(
    refused,
    [],
    `The integration sends operations Control Plane refuses: ${refused.join(', ')}`
  )
})
