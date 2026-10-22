import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyContractSchemasLoadable } from '../../src/execution/contract-schema.js'

// Startup guard: a service image that did not carry the contract schemas must
// fail to start, not start and then fail on the first published result. The
// Dockerfile copies the whole integration-contract family and lets the runtime
// select the version directory, so this also pins that the resolver still finds
// the schemas the package ships against.
//
// The validators are built once and cached, so this is the same code path the
// first `assertWorkflowResult` call would take -- just moved to startup.

test('verifyContractSchemasLoadable loads the canonical schemas', () => {
  assert.doesNotThrow(() => verifyContractSchemasLoadable())
})
