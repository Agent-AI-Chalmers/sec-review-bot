import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { formatGenerated, renderOpenApiTypes } from '@sec-review-bot/contract-codegen'

import { REPOSITORY_ROOT as repositoryRoot, SPEC_PATH as contractPath } from './paths.js'

const outputPaths = [
  path.resolve(repositoryRoot, 'services', 'memory-catalog', 'src', 'contract-types.generated.ts'),
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

export async function renderGeneratedTypes(outputPath: string): Promise<string> {
  const generated = await renderOpenApiTypes(contractPath)
  const source = `// Generated from contracts/memory-catalog-api/v1/openapi.yaml. Do not edit.\n${generated}`
  return formatGenerated(outputPath, source)
}

export { outputPaths }

if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) {
  await Promise.all(
    outputPaths.map(async (outputPath) =>
      writeFile(outputPath, await renderGeneratedTypes(outputPath))
    )
  )
}
