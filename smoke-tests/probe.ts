import assert from 'node:assert/strict'

import { submit, verifyExecutionIdentity, verifyReplay } from './execution.js'
import { admit, verifyRecovery } from './review-runs.js'
import { verifyBff } from './bff.js'

function required(value: string | undefined, name: string): string {
  assert.ok(value, `${name} is required`)
  return value
}

const [, , phase, runId, beforeJson, afterJson] = process.argv

switch (phase) {
  case 'admit':
    await admit()
    break
  case 'submit':
    await submit()
    break
  case 'verify-replay':
    await verifyReplay(required(runId, 'workflow ID'))
    break
  case 'verify-execution-identity':
    verifyExecutionIdentity(
      required(runId, 'workflow ID'),
      required(beforeJson, 'before description'),
      required(afterJson, 'after description')
    )
    break
  case 'verify-bff':
    await verifyBff(required(runId, 'workflow ID'))
    break
  case 'verify-recovery':
    await verifyRecovery(required(runId, 'workflow ID'))
    break
  default:
    throw new Error(`Unknown smoke probe phase: ${phase}`)
}
