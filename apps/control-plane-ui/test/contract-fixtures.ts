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

export const TRANSCRIPT_CONTRACT_ROOT = path.join(
  workspaceRoot(),
  'contracts',
  'agent-transcript',
  'v1'
)

export function transcriptCorpus(name: string): string {
  return readFileSync(
    path.join(TRANSCRIPT_CONTRACT_ROOT, 'corpus', name),
    'utf8'
  )
}

export function transcriptManifest(): { valid: string[]; invalid: string[] } {
  return JSON.parse(transcriptCorpus('manifest.json')) as {
    valid: string[]
    invalid: string[]
  }
}
