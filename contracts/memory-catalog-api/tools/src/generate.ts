import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString } from 'openapi-typescript'

const toolsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const contractPath = path.resolve(toolsRoot, '..', 'openapi.yaml')
const outputPath = path.resolve(
  toolsRoot,
  '..',
  '..',
  '..',
  'memory-catalog',
  'src',
  'contract-types-generated.ts'
)
export async function renderGeneratedTypes(): Promise<string> {
  const generated = astToString(
    await openapiTS(new URL(`file://${contractPath}`))
  )
  return `// Generated from contracts/memory-catalog-api/openapi.yaml. Do not edit.\n${generated}`
}

export { outputPath }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(outputPath, await renderGeneratedTypes())
}
