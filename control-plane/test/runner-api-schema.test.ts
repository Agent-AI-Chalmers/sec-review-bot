// Keep the generated TypeScript view of the runner's API current.
//
// The document is checked against the service code in the agents package, so it cannot
// describe an API the runner no longer serves. This guards the next link: the projection
// of that document into this package. Without it the committed file could lag the contract
// and the control plane would typecheck against shapes the runner had already changed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { OUTPUT_PATH, renderRunnerApiTypes } from '../scripts/generate-runner-api-types.js'

test('the committed runner API types match the contract document', async () => {
  const committed = readFileSync(OUTPUT_PATH, 'utf8')

  assert.equal(
    committed,
    await renderRunnerApiTypes(),
    `${OUTPUT_PATH} is stale. Regenerate it with: pnpm run generate:runner-api`
  )
})

test('the generated types still describe the shapes the client depends on', async () => {
  // A projection that lost its components would still parse, so assert the parts the
  // client reads are present rather than only that the file matches.
  const generated = readFileSync(OUTPUT_PATH, 'utf8')

  for (const name of ['RunResponse', 'RunnerError', 'RunStatusResponse', 'RunStatusToken']) {
    assert.ok(generated.includes(name), `${name} is missing from the generated types`)
  }
})
