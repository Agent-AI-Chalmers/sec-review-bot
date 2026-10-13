// A projection can render cleanly and still have lost a shape the consumer reads.
//
// The staleness check proves the committed file matches a fresh render of the contract; it
// cannot see that the render itself dropped, say, `ReviewRunRecord` because a component moved
// or the projector changed. These assert the parts each consumer depends on are present.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { OUTPUT_PATH as CONTROL_PLANE_API_TYPES_PATH } from '../scripts/generate-control-plane-types.js'
import { OUTPUT_PATH as RUNNER_API_SCHEMA_PATH } from '../scripts/generate-runner-api-types.js'

test('the control-plane API projection still describes the shapes the client reads', () => {
  const generated = readFileSync(CONTROL_PLANE_API_TYPES_PATH, 'utf8')
  for (const name of [
    'ReviewRunRecord',
    'ReviewRunAdmission',
    'PublicationWork',
    'PublicationStepRecord'
  ]) {
    assert.ok(generated.includes(name), `${name} is missing from the generated types`)
  }
})

test('the runner API projection still describes the shapes the client reads', () => {
  const generated = readFileSync(RUNNER_API_SCHEMA_PATH, 'utf8')
  for (const name of ['RunResponse', 'RunnerError', 'RunStatusResponse', 'RunStatusToken']) {
    assert.ok(generated.includes(name), `${name} is missing from the generated types`)
  }
})
