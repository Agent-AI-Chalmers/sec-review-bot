// Regenerate this family's contract-derived artifacts.
//
// The generators that read this family's contract are listed in `generatedArtifacts()` below;
// `pnpm run check` then proves the committed files match what this produced.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generatedArtifacts as schemas } from './generate-schemas.js'
import { generatedArtifacts as types } from './generate-types.js'
import { REPO_ROOT } from './repo-root.js'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const artifact of [...types(), ...schemas()]) {
    mkdirSync(path.dirname(artifact.output), { recursive: true })
    writeFileSync(artifact.output, await artifact.render())
    console.log(`Wrote ${path.relative(REPO_ROOT, artifact.output)}`)
  }
}
