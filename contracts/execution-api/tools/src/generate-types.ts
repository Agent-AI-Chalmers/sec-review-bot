// Project the Execution API OpenAPI document into TypeScript.
//
// The document is the hand-maintained source of truth for the Execution API.
// This module projects it into both the provider and consumer TypeScript packages.
//
// The generator and the test that fails when the committed file lags both call
// `renderExecutionApiTypes`, so they cannot disagree about what "current" means.
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import prettier from 'prettier'
import { parse } from 'yaml'

import type { GeneratedArtifact } from './generated-artifact.js'
import { renderWorkflowInputDeclarations } from './generate-api-types.js'
import { renderKubbTypes } from './render-kubb-types.js'
import { REPO_ROOT } from './repo-root.js'

export { REPO_ROOT }
export const REVIEW_RUNS_ROOT = path.join(REPO_ROOT, 'review-runs')
export const SPEC_PATH = path.resolve(
  REPO_ROOT,
  'contracts',
  'execution-api',
  'v1',
  'openapi.yaml'
)
export const REVIEW_RUNS_OUTPUT_PATH = path.join(
  REVIEW_RUNS_ROOT,
  'src',
  'execution-api-schema.ts'
)
export const GATEWAY_OUTPUT_PATH = path.join(
  REPO_ROOT,
  'execution-gateway',
  'src',
  'execution-api-types-generated.ts'
)

const HEADER = `// Generated from ${path.relative(REPO_ROOT, SPEC_PATH)} (path relative to the repository root). Do not edit.
//
// This file is a generated projection of the contract. Regenerate it with
// \`pnpm --dir contracts/execution-api/tools run generate\`.
`

function renderOperationOptionsById(spec: unknown): string {
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> })
    .paths
  if (paths === undefined) throw new Error('Execution API has no paths')
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

/** The committed content of `src/execution-api-schema.ts`. */
export async function renderExecutionApiTypes(
  outputPath: string
): Promise<string> {
  const spec = parse(await readFile(SPEC_PATH, 'utf8')) as unknown
  const composedTypes = `
${await renderWorkflowInputDeclarations()}

${renderOperationOptionsById(spec)}

export interface WorkflowInputByName {
  'issue-review': IssueReviewInput
  'pull-request-review': PullRequestReviewInput
  'repository-review': RepositoryReviewInput
}

export type ExecutionWorkflow = keyof WorkflowInputByName

export type CreateRunRequestFor<Workflow extends ExecutionWorkflow> =
  Omit<CreateRunRequest, 'input'> & {
    input: WorkflowInputByName[Workflow]
  }
`
  const rendered = HEADER + (await renderKubbTypes(SPEC_PATH)) + composedTypes
  // `format` does not read the project's Prettier config from `filepath`; it has to be
  // resolved and passed, or the output keeps the generator's own quoting and fails
  // `format:check`.
  const options = await prettier.resolveConfig(outputPath)
  return await prettier.format(rendered, { ...options, filepath: outputPath })
}

/** This generator's outputs as the shared descriptor the checker walks. */
export function generatedArtifacts(): GeneratedArtifact[] {
  return [REVIEW_RUNS_OUTPUT_PATH, GATEWAY_OUTPUT_PATH].map((output) => ({
    output,
    render: async () => await renderExecutionApiTypes(output)
  }))
}
