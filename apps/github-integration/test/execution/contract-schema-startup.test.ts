import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { verifyContractSchemasLoadable } from '../../src/execution/contract-schema.js'

test('an explicit contract root is authoritative', () => {
  const emptyRoot = mkdtempSync(path.join(tmpdir(), 'github-contract-root-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--eval',
        "import('./src/execution/contract-schema.ts').then(({ verifyContractSchemasLoadable }) => verifyContractSchemasLoadable())"
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, SEC_REVIEW_CONTRACTS_ROOT: emptyRoot }
      }
    )

    assert.notEqual(result.status, 0)
    assert.match(
      `${result.stdout}${result.stderr}`,
      /SEC_REVIEW_CONTRACTS_ROOT=.*does not contain/
    )
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }
})

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
