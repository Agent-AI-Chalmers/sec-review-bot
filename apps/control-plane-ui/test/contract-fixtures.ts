import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function workspaceRoot(): string {
  let current = import.meta.dirname
  while (!existsSync(path.join(current, 'contracts', 'README.md'))) {
    const parent = path.dirname(current)
    if (parent === current)
      throw new Error('Could not locate workspace contracts root.')
    current = parent
  }
  return current
}

export const TRAJECTORY_CONTRACT_ROOT = path.join(
  workspaceRoot(),
  'contracts',
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
