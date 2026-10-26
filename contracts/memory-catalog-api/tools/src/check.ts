import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { outputPaths, renderGeneratedTypes } from './generate.js'

for (const outputPath of outputPaths) {
  const expected = await renderGeneratedTypes(outputPath)
  const actual = await readFile(outputPath, 'utf8')
  if (actual !== expected) {
    throw new Error(
      `${path.relative(process.cwd(), outputPath)} is stale; run pnpm run generate.`
    )
  }
}
