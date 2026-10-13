// Keep the generated TypeScript view of the Control Plane API current.
//
// The document (contracts/control-plane-api/openapi.yaml) is the hand-written single source
// of truth, validated by Spectral rather than checked against route schemas. This guards the
// next link: the projection of that document into github-integration. Without it the
// committed file could lag the contract and the client would typecheck against shapes the
// service already changed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CONTRACT_TYPES_PATH,
  ERROR_CODES_PATH,
  OUTPUT_PATH,
  renderContractTypes,
  renderControlPlaneApiTypes,
  renderErrorCodeTypes
} from '../scripts/generate-control-plane-types.js'

test('the committed control-plane API types match the contract document', async () => {
  const committed = readFileSync(OUTPUT_PATH, 'utf8')

  assert.equal(
    committed,
    await renderControlPlaneApiTypes(),
    `${OUTPUT_PATH} is stale. Regenerate it with: pnpm run generate:control-plane-types`
  )
})

test('the committed server contract types match the contract document', async () => {
  const committed = readFileSync(CONTRACT_TYPES_PATH, 'utf8')

  assert.equal(
    committed,
    await renderContractTypes(),
    `${CONTRACT_TYPES_PATH} is stale. Regenerate it with: pnpm run generate:control-plane-types`
  )
})

test('the committed error-code types match the contract document', async () => {
  const committed = readFileSync(ERROR_CODES_PATH, 'utf8')

  assert.equal(
    committed,
    await renderErrorCodeTypes(),
    `${ERROR_CODES_PATH} is stale. Regenerate it with: pnpm run generate:control-plane-types`
  )
})

test('the generated types still describe the shapes the client depends on', async () => {
  // A projection that lost its components would still parse, so assert the parts the
  // client reads are present rather than only that the file matches.
  const generated = readFileSync(OUTPUT_PATH, 'utf8')

  for (const name of [
    'ReviewRunRecord',
    'ReviewRunAdmission',
    'PublicationWork',
    'PublicationStepRecord'
  ]) {
    assert.ok(generated.includes(name), `${name} is missing from the generated types`)
  }
})
