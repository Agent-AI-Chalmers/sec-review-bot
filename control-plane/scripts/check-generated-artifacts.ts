// The single staleness check for every contract-derived artifact.
//
// Each generator declares its outputs (`generatedArtifacts()`), the manifest
// (`contracts/generated-artifacts.json`) lists the generators, and this walks that list:
// render every output from the contract and compare it to the committed file. One place
// decides "is a projection fresh", so a consumer package does not have to own the check for
// a file that lands in another package.
//
// Run as a script (`pnpm run check:generated-artifacts`) it exits non-zero and prints every
// stale file; imported as `staleGeneratedArtifacts()` it returns them so a test can assert
// against the same logic without a second implementation.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generatedArtifacts as controlPlaneSchemas } from './generate-control-plane-schemas.js'
import { generatedArtifacts as controlPlaneTypes } from './generate-control-plane-types.js'
import { generatedArtifacts as runnerApiTypes } from './generate-runner-api-types.js'
import type { GeneratedArtifact } from './generated-artifact.js'

export const CONTROL_PLANE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(CONTROL_PLANE_ROOT, '..')
export const MANIFEST_PATH = path.join(REPO_ROOT, 'contracts', 'generated-artifacts.json')

/** How to re-render each manifest entry, keyed by the manifest's `name`. Adding a generator
 * to the manifest without an entry here (or vice versa) fails the manifest test. */
export const GENERATORS: Record<string, () => GeneratedArtifact[]> = {
  'control-plane-types': controlPlaneTypes,
  'control-plane-schemas': controlPlaneSchemas,
  'runner-api-types': runnerApiTypes
}

export interface Manifest {
  generators: Array<{ name: string; command: string; outputs: string[] }>
}

export interface StaleArtifact {
  /** Path relative to the repository root. */
  output: string
  /** The command that regenerates it, from the manifest. */
  command: string
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
}

/** Every committed artifact that does not match a fresh render of its contract. */
export async function staleGeneratedArtifacts(): Promise<StaleArtifact[]> {
  const stale: StaleArtifact[] = []
  for (const generator of readManifest().generators) {
    const render = GENERATORS[generator.name]
    if (render === undefined) {
      throw new Error(`No renderer registered for generator ${generator.name}.`)
    }
    for (const artifact of render()) {
      const output = path.relative(REPO_ROOT, artifact.output)
      const committed = readFileSync(artifact.output, 'utf8')
      if (committed !== (await artifact.render())) {
        stale.push({ output, command: generator.command })
      }
    }
  }
  return stale
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stale = await staleGeneratedArtifacts()
  if (stale.length > 0) {
    for (const { output, command } of stale) {
      console.error(`stale: ${output}\n  regenerate with: ${command}`)
    }
    process.exitCode = 1
  } else {
    console.log('all generated artifacts are fresh')
  }
}
