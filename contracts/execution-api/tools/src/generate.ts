// Regenerate this family's contract-derived artifacts.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generatedArtifacts as payloadTypes } from './generate-api-types.js'
import { generatedArtifacts as apiTypes } from './generate-types.js'
import { REPO_ROOT } from './repo-root.js'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const artifact of [...apiTypes(), ...payloadTypes()]) {
    mkdirSync(path.dirname(artifact.output), { recursive: true })
    writeFileSync(artifact.output, await artifact.render())
    console.log(`Wrote ${path.relative(REPO_ROOT, artifact.output)}`)
  }
}
