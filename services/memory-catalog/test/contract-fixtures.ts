import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { CONTRACTS_ROOT } from './project-paths.js'

export const CATALOG_CONTRACT_ROOT = path.join(
  CONTRACTS_ROOT,
  'memory-catalog-api',
  'v1'
)
const fixturesRoot = path.join(CATALOG_CONTRACT_ROOT, 'fixtures')

export function contractFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(fixturesRoot, name), 'utf8')
  ) as unknown
}

export function contractFixtureManifest(): {
  schema_fixtures: Record<string, string>
  invalid_schema_fixtures: Record<string, string>
} {
  return JSON.parse(
    readFileSync(path.join(fixturesRoot, 'manifest.json'), 'utf8')
  ) as ReturnType<typeof contractFixtureManifest>
}

export function contractFixtureNames(): string[] {
  return readdirSync(fixturesRoot)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort()
}
