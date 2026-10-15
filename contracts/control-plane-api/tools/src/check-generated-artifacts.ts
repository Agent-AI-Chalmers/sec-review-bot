// Prove this family's committed artifacts match a fresh render of its contract.
//
// Walk the generators, render each output, compare to the committed file. One place decides
// "is a projection fresh" for this family, so it does not matter which package the projection
// lands in. Run as a script it exits non-zero and prints every stale file with the command
// that regenerates it; `staleGeneratedArtifacts()` returns them so a test can assert the same.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generatedArtifacts as schemas } from './generate-schemas.js'
import { generatedArtifacts as types } from './generate-types.js'
import { REPO_ROOT } from './repo-root.js'

const REGENERATE_COMMAND =
  'pnpm --dir contracts/control-plane-api/tools run generate'

export interface StaleArtifact {
  /** Path relative to the repository root. */
  output: string
  /** The command that regenerates it. */
  command: string
}

/** Every committed artifact of this family that does not match a fresh render. */
export async function staleGeneratedArtifacts(): Promise<StaleArtifact[]> {
  const stale: StaleArtifact[] = []
  for (const artifact of [...types(), ...schemas()]) {
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
    console.log('all control-plane-api artifacts are fresh')
  }
}
