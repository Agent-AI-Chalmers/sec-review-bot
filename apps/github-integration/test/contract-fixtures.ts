import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { EXECUTION_API_VERSION } from '../src/execution/execution-api-version.js'

import { CONTRACTS_ROOT } from './project-paths.js'

export { CONTRACTS_ROOT } from './project-paths.js'

const executionApiRoot = path.join(CONTRACTS_ROOT, 'execution-api')
const contractFixturesRoot = path.join(
  executionApiRoot,
  EXECUTION_API_VERSION,
  'fixtures'
)
const executionApiSchemasRoot = path.join(
  executionApiRoot,
  EXECUTION_API_VERSION,
  'schemas'
)

export function contractFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot, name), 'utf8'))
}

export function contractFixtureManifest(): unknown {
  return JSON.parse(
    readFileSync(path.join(contractFixturesRoot, 'manifest.json'), 'utf8')
  )
}

export function contractFixtureFiles(): string[] {
  return readdirSync(contractFixturesRoot)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function contractSchema(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(executionApiSchemasRoot, name), 'utf8')
  )
}

export function contractSchemaFiles(): string[] {
  return readdirSync(executionApiSchemasRoot)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
}
