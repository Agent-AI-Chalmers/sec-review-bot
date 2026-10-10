import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (existsSync(path.join(current, 'contracts', 'integration-contract', 'v5', 'fixtures'))) {
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
const contractFixturesRoot = (version: string): string =>
  path.join(contractRoot, version, 'fixtures')
const contractSchemasRoot = (version: string): string => path.join(contractRoot, version, 'schemas')

export function contractFixture(version: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot(version), name), 'utf8'))
}

export function contractFixtureManifest(version: string): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot(version), 'manifest.json'), 'utf8'))
}

export function contractFixtureFiles(version: string): string[] {
  return readdirSync(contractFixturesRoot(version))
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function contractSchema(version: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractSchemasRoot(version), name), 'utf8'))
}

export function contractSchemaFiles(version: string): string[] {
  return readdirSync(contractSchemasRoot(version))
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
}
