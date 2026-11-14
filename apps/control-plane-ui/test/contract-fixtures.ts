import { readFileSync } from 'node:fs'
import path from 'node:path'

// Repository layout is local to this package's shared contract fixtures.
const contractsRoot = path.resolve(import.meta.dirname, '../../../contracts')

export const TRAJECTORY_CONTRACT_ROOT = path.join(
  contractsRoot,
  'agent-trajectory',
  'v1'
)

export function trajectoryCorpus(name: string): string {
  return readFileSync(
    path.join(TRAJECTORY_CONTRACT_ROOT, 'corpus', name),
    'utf8'
  )
}

export function trajectoryManifest(): { valid: string[]; invalid: string[] } {
  return JSON.parse(trajectoryCorpus('manifest.json')) as {
    valid: string[]
    invalid: string[]
  }
}

export const TAR_ZSTD_CORPUS_ROOT = path.join(
  contractsRoot,
  'tar-zstd-artifact',
  'envelope',
  'v1',
  'corpus'
)
