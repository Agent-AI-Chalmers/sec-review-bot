import { readFile } from 'node:fs/promises'

import { outputPath, renderGeneratedTypes } from './generate.js'

const expected = await renderGeneratedTypes()
const actual = await readFile(outputPath, 'utf8')
if (actual !== expected) {
  throw new Error(
    'memory-catalog/src/contract-types-generated.ts is stale; run pnpm run generate.'
  )
}
