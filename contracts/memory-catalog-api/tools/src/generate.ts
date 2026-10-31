import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import prettier from 'prettier'
import { parse } from 'yaml'

import { renderKubbTypes } from './render-kubb-types.js'

const toolsRoot = path.resolve(import.meta.dirname, '..')
const contractPath = path.resolve(toolsRoot, '../v1/openapi.yaml')
const repositoryRoot = path.resolve(toolsRoot, '../../..')
const outputPaths = [
  path.resolve(
    repositoryRoot,
    'services',
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

function renderOperationOptionsById(spec: unknown): string {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> })
    .paths
  if (paths === undefined) throw new Error('Memory Catalog API has no paths')
  const entries: string[] = []
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      const operationId = (operation as { operationId?: unknown }).operationId
      if (typeof operationId !== 'string') continue
      const typeName =
        operationId.charAt(0).toUpperCase() + operationId.slice(1)
      entries.push(`  ${operationId}: ${typeName}Options`)
    }
  }
  return `export interface OperationOptionsById {\n${entries.join('\n')}\n}`
}

export async function renderGeneratedTypes(
  outputPath: string
): Promise<string> {
  const generated = await renderKubbTypes(contractPath)
  const spec = parse(await readFile(contractPath, 'utf8')) as unknown
  const source = `// Generated from contracts/memory-catalog-api/v1/openapi.yaml. Do not edit.\n${generated}\n${renderOperationOptionsById(spec)}\n`
  const options = await prettier.resolveConfig(outputPath)
  return prettier.format(source, { ...options, filepath: outputPath })
}

export { outputPaths }

if (
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1])
) {
  await Promise.all(
    outputPaths.map(async (outputPath) =>
      writeFile(outputPath, await renderGeneratedTypes(outputPath))
    )
  )
}
