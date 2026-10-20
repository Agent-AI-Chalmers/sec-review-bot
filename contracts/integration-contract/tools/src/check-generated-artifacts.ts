// Prove this family's committed artifact matches a fresh render of its contract.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generatedArtifacts as workflowInputTypes } from './generate-workflow-input-types.js'
import { generatedArtifacts as apiTypes } from './generate-types.js'
import { REPO_ROOT } from './repo-root.js'

const REGENERATE_COMMAND =
  'pnpm --dir contracts/integration-contract/tools run generate'

export interface StaleArtifact {
  output: string
  command: string
}

/** Every committed artifact of this family that does not match a fresh render. */
export async function staleGeneratedArtifacts(): Promise<StaleArtifact[]> {
  const stale: StaleArtifact[] = []
  for (const artifact of [...apiTypes(), ...workflowInputTypes()]) {
    const output = path.relative(REPO_ROOT, artifact.output)
    const committed = readFileSync(artifact.output, 'utf8')
    if (committed !== (await artifact.render())) {
      stale.push({ output, command: REGENERATE_COMMAND })
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
    console.log('all integration-contract artifacts are fresh')
  }
}
