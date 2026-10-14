import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONTRACT_VERSION_DIR } from '../src/runner/contract-version.js'

/** The repository root, located by walking up to the shared contracts tree. Exported so the
 * package's tests anchor on one implementation of "where is the repo" rather than each
 * carrying its own copy of the walk. */
export function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (
      existsSync(
        path.join(current, 'contracts', 'integration-contract', CONTRACT_VERSION_DIR, 'fixtures')
      )
    ) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error('Could not locate workspace contract fixtures root.')
    }
    current = parent
  }
}

const contractRoot = path.join(workspaceRoot(), 'contracts', 'integration-contract')
const contractFixturesRoot = path.join(contractRoot, CONTRACT_VERSION_DIR, 'fixtures')
const contractSchemasRoot = path.join(contractRoot, CONTRACT_VERSION_DIR, 'schemas')

export function contractFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot, name), 'utf8'))
}

export function contractFixtureManifest(): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot, 'manifest.json'), 'utf8'))
}

export function contractFixtureFiles(): string[] {
  return readdirSync(contractFixturesRoot)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function contractSchema(name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractSchemasRoot, name), 'utf8'))
}

export function contractSchemaFiles(): string[] {
  return readdirSync(contractSchemasRoot)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
}
