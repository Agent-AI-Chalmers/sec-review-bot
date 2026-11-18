import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { format } from 'oxfmt'
import { parse } from 'yaml'

import { renderOpenApiTypes } from '@sec-review-bot/contract-codegen'

import { REPOSITORY_ROOT as repositoryRoot, SPEC_PATH as contractPath } from './paths.js'

const outputPaths = [
  path.resolve(repositoryRoot, 'services', 'memory-catalog', 'src', 'contract-types-generated.ts'),
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
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths
  if (paths === undefined) throw new Error('Memory Catalog API has no paths')
  const entries: string[] = []
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      const operationId = (operation as { operationId?: unknown }).operationId
      if (typeof operationId !== 'string') continue
      const typeName = operationId.charAt(0).toUpperCase() + operationId.slice(1)
      entries.push(`  ${operationId}: ${typeName}Options`)
    }
  }
  return `export interface OperationOptionsById {\n${entries.join('\n')}\n}`
}

export async function renderGeneratedTypes(outputPath: string): Promise<string> {
  const generated = await renderOpenApiTypes(contractPath)
  const spec = parse(await readFile(contractPath, 'utf8')) as unknown
  const source = `// Generated from contracts/memory-catalog-api/v1/openapi.yaml. Do not edit.\n${generated}\n\n${renderOperationOptionsById(spec)}\n`
  const result = await format(outputPath, source, {
    semi: false,
    singleQuote: true,
    trailingComma: 'none',
    printWidth: 100,
    sortImports: false,
    sortPackageJson: false,
    embeddedLanguageFormatting: 'off',
    proseWrap: 'preserve'
  })
  if (result.errors.length > 0) {
    throw new Error(`Failed to format ${outputPath}: ${JSON.stringify(result.errors)}`)
  }
  return result.code
}

export { outputPaths }

if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) {
  await Promise.all(
    outputPaths.map(async (outputPath) =>
      writeFile(outputPath, await renderGeneratedTypes(outputPath))
    )
  )
}
