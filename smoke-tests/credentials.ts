import assert from 'node:assert/strict'

function requiredEnv(name: string): string {
  const value = process.env[name]
  assert.ok(value, `${name} is required`)
  return value
}

// run.sh defines the test credentials; Compose passes them to services and probes.
export const serviceToken = requiredEnv('REVIEW_RUNS_SERVICE_TOKEN')
export const readToken = requiredEnv('REVIEW_RUNS_READ_TOKEN')
export const executionToken = requiredEnv('EXECUTION_API_TOKEN')
export const catalogOperatorToken = requiredEnv(
  'AGENT_MEMORY_CATALOG_OPERATOR_TOKEN'
)
export const uiAccessToken = requiredEnv('CONTROL_PLANE_UI_ACCESS_TOKEN')
