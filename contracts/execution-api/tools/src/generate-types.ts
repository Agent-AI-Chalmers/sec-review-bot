// Project the Execution API OpenAPI document into TypeScript.
//
// The document is the hand-maintained source of truth for the Execution API.
// This module projects it into both the provider and consumer TypeScript packages.
//
// The generator and the test that fails when the committed file lags both call
// `renderExecutionApiTypes`, so they cannot disagree about what "current" means.
import path from 'node:path'

import { formatGenerated, renderOpenApiTypes } from '@sec-review-bot/contract-codegen'

import type { GeneratedArtifact } from './generated-artifact.js'
import { renderWorkflowInputDeclarations } from './generate-api-types.js'
import { REPO_ROOT } from './repo-root.js'

export { REPO_ROOT }
export const REVIEW_RUNS_ROOT = path.join(REPO_ROOT, 'services', 'review-runs')
export const SPEC_PATH = path.resolve(REPO_ROOT, 'contracts', 'execution-api', 'v1', 'openapi.yaml')
export const REVIEW_RUNS_OUTPUT_PATH = path.join(
  REVIEW_RUNS_ROOT,
  'src',
  'execution-api-types.generated.ts'
)
export const GATEWAY_OUTPUT_PATH = path.join(
  REPO_ROOT,
  'services',
  'execution-gateway',
  'src',
  'execution-api-types.generated.ts'
)

const HEADER = `// Generated from ${path.relative(REPO_ROOT, SPEC_PATH)} (path relative to the repository root). Do not edit.
//
// This file is a generated projection of the contract. Regenerate it with
// \`pnpm --dir contracts/execution-api/tools run generate\`.
`

/** The committed content of `src/execution-api-types.generated.ts`. */
export async function renderExecutionApiTypes(outputPath: string): Promise<string> {
  const composedTypes = `
${await renderWorkflowInputDeclarations()}

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
  const rendered = HEADER + (await renderOpenApiTypes(SPEC_PATH)) + '\n' + composedTypes
  return formatGenerated(outputPath, rendered)
}

/** This generator's outputs as the shared descriptor the checker walks. */
export function generatedArtifacts(): GeneratedArtifact[] {
  return [REVIEW_RUNS_OUTPUT_PATH, GATEWAY_OUTPUT_PATH].map((output) => ({
    output,
    render: async () => await renderExecutionApiTypes(output)
  }))
}
