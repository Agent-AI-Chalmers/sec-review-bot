import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString } from 'openapi-typescript'
import prettier from 'prettier'

const toolsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const contractPath = path.resolve(toolsRoot, '..', 'v1', 'openapi.yaml')
const repositoryRoot = path.resolve(toolsRoot, '..', '..', '..')
const outputPaths = [
  path.resolve(
    repositoryRoot,
    'memory-catalog',
    'src',
    'contract-types-generated.ts'
  ),
  path.resolve(
    repositoryRoot,
    'apps',
    'control-plane-ui',
    'browser',
    'features',
    'memory',
    'api-types.generated.ts'
  )
]
export async function renderGeneratedTypes(
  outputPath: string
): Promise<string> {
  const generated = astToString(
    await openapiTS(new URL(`file://${contractPath}`))
  )
  const source = `// Generated from contracts/memory-catalog-api/v1/openapi.yaml. Do not edit.\n${generated}`
  const options = await prettier.resolveConfig(outputPath)
  return prettier.format(source, { ...options, filepath: outputPath })
}

export { outputPaths }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await Promise.all(
    outputPaths.map(async (outputPath) =>
      writeFile(outputPath, await renderGeneratedTypes(outputPath))
    )
  )
}
