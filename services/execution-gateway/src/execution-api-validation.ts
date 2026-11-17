import { contractsRoot } from './contract-paths.js'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import Ajv2020Module, { type AnySchemaObject } from 'ajv/dist/2020.js'

import type {
  ExecutionError,
  ExecutionWorkflow,
  WorkflowInputByName
} from './execution-api-types-generated.js'
import { EXECUTION_API_VERSION } from './execution-api-version.js'

const schemaByWorkflow: Record<ExecutionWorkflow, string> = {
  'issue-review': 'issue-review-input.schema.json',
  'pull-request-review': 'pull-request-review-input.schema.json',
  'repository-review': 'repository-review-input.schema.json'
}

const resultSchemaByWorkflow: Record<string, string> = {
  'issue-review': 'issue-review-result.schema.json',
  'pull-request-review': 'pull-request-review-result.schema.json',
  'repository-review': 'repository-review-result.schema.json'
}

function schemasRoot(): string {
  return path.join(
    contractsRoot(),
    'execution-api',
    EXECUTION_API_VERSION,
    'schemas'
  )
}

function loadSchemas() {
  const root = schemasRoot()
  const ajv = new Ajv2020Module.default({ allErrors: true, strict: true })
  for (const name of readdirSync(root).filter((entry) =>
    entry.endsWith('.json')
  )) {
    const schema = JSON.parse(
      readFileSync(path.join(root, name), 'utf8')
    ) as AnySchemaObject
    ajv.addSchema(schema, name)
  }
  return ajv
}

let schemas: ReturnType<typeof loadSchemas> | undefined

export function supportedWorkflows(): ExecutionWorkflow[] {
  return Object.keys(schemaByWorkflow) as ExecutionWorkflow[]
}

export function isExecutionError(value: unknown): value is ExecutionError {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const error = value as Record<string, unknown>
  return (
    typeof error.category === 'string' &&
    ['input', 'workflow', 'llm', 'runtime', 'internal'].includes(
      error.category
    ) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean' &&
    (error.details === undefined ||
      (typeof error.details === 'object' &&
        error.details !== null &&
        !Array.isArray(error.details)))
  )
}

export function validateExecutionInput<Workflow extends ExecutionWorkflow>(
  workflow: Workflow,
  input: unknown
): asserts input is WorkflowInputByName[Workflow] {
  if (!Object.hasOwn(schemaByWorkflow, workflow))
    throw new Error(`Unsupported workflow: ${workflow}`)
  const schemaName = schemaByWorkflow[workflow]
  schemas ??= loadSchemas()
  const validator = schemas.getSchema(schemaName)
  if (!validator)
    throw new Error(`Missing execution input schema: ${schemaName}`)
  if (!validator(input)) {
    const first = validator.errors?.[0]
    const location = first?.instancePath ? ` at ${first.instancePath}` : ''
    throw new Error(
      `Execution input does not match API ${EXECUTION_API_VERSION}${location}: ${first?.message ?? 'invalid input'}`
    )
  }
}

export function validateExecutionResult(
  workflow: string,
  result: unknown
): void {
  const schemaName = Object.hasOwn(resultSchemaByWorkflow, workflow)
    ? resultSchemaByWorkflow[workflow]
    : undefined
  if (!schemaName) throw new Error(`Unsupported workflow: ${workflow}`)
  schemas ??= loadSchemas()
  const validator = schemas.getSchema(schemaName)
  if (!validator)
    throw new Error(`Missing execution result schema: ${schemaName}`)
  if (!validator(result)) {
    const first = validator.errors?.[0]
    const location = first?.instancePath ? ` at ${first.instancePath}` : ''
    throw new Error(
      `Execution result does not match API ${EXECUTION_API_VERSION}${location}: ${first?.message ?? 'invalid result'}`
    )
  }
}
