import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function workspaceRoot (): string {
  let current = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    if (
      existsSync(path.join(current, 'contracts', 'README.md')) &&
      existsSync(path.join(current, 'contracts', 'fixtures'))
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

const contractFixturesRoot = path.join(workspaceRoot(), 'contracts', 'fixtures')
const contractSchemasRoot = path.join(workspaceRoot(), 'contracts', 'schemas')

export function contractFixture (version: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot, version, name), 'utf8'))
}

export function contractFixtureManifest (version: string): unknown {
  return JSON.parse(readFileSync(path.join(contractFixturesRoot, version, 'manifest.json'), 'utf8'))
}

export function contractFixtureFiles (version: string): string[] {
  return readdirSync(path.join(contractFixturesRoot, version))
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function contractSchema (version: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(contractSchemasRoot, version, name), 'utf8'))
}

export function contractSchemaFiles (version: string): string[] {
  return readdirSync(path.join(contractSchemasRoot, version))
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
}
