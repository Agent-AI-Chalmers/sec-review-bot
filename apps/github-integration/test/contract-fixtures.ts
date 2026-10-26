import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXECUTION_API_VERSION } from '../src/execution/execution-api-version.js'

/** The repository root, located by walking up to the shared `contracts/` tree. Exported so the
 * package's tests anchor on one implementation of "where is the repo" rather than each
 * carrying its own copy of the walk. The probe is the contracts root's own `README.md`, not
 * any one family inside it: each family derives its own paths from `CONTRACTS_ROOT`, and a
 * merely-named `contracts/` directory (such as this package's own `test/contracts/`) does not
 * match. */
export function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (existsSync(path.join(current, 'contracts', 'README.md'))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error('Could not locate workspace contracts root.')
    }
    current = parent
  }
}

export const CONTRACTS_ROOT = path.join(workspaceRoot(), 'contracts')

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
