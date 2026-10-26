import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020Module, {
  type AnySchemaObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js'

import type {
  components,
  ExecutionWorkflow,
  WorkflowInputByName,
} from './execution-api-types-generated.js'
import { EXECUTION_API_VERSION } from './execution-api-version.js'

function contractsRoot(): string {
  const configured = process.env.SEC_REVIEW_CONTRACTS_ROOT?.trim()
  if (configured) return path.resolve(configured)
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'contracts',
  )
}

const schemaByWorkflow: Record<ExecutionWorkflow, string> = {
  'issue-review': 'issue-review-input.schema.json',
  'pull-request-review': 'pull-request-review-input.schema.json',
  'repository-review': 'repository-review-input.schema.json',
}

const resultSchemaByWorkflow: Record<string, string> = {
  'issue-review': 'issue-review-result.schema.json',
  'pull-request-review': 'pull-request-review-result.schema.json',
  'repository-review': 'repository-review-result.schema.json',
}

function schemasRoot(): string {
  return path.join(
    contractsRoot(),
    'execution-api',
    EXECUTION_API_VERSION,
    'schemas',
  )
}

function createValidators(): Map<string, ValidateFunction> {
  const root = schemasRoot()
  const ajv = new Ajv2020Module.default({ allErrors: true, strict: true })
  for (const name of readdirSync(root).filter((entry) =>
    entry.endsWith('.json'),
  )) {
    const schema = JSON.parse(
      readFileSync(path.join(root, name), 'utf8'),
    ) as AnySchemaObject
    ajv.addSchema(schema, name)
  }
  return new Map(
    Object.entries(schemaByWorkflow).map(([workflow, name]) => {
      const validator = ajv.getSchema(name)
      if (!validator) throw new Error(`Missing execution input schema: ${name}`)
      return [workflow, validator]
    }),
  )
}

let validators: Map<string, ValidateFunction> | undefined
let resultValidators: Map<string, ValidateFunction> | undefined
export function supportedWorkflows(): ExecutionWorkflow[] {
  return Object.keys(schemaByWorkflow) as ExecutionWorkflow[]
}

export function isExecutionError(
  value: unknown,
): value is components['schemas']['ExecutionError'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const error = value as Record<string, unknown>
  return (
    ['input', 'workflow', 'llm', 'runtime', 'internal'].includes(
      String(error.category),
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
  input: unknown,
): asserts input is WorkflowInputByName[Workflow] {
  validators ??= createValidators()
  const validator = validators.get(workflow)
  if (!validator) throw new Error(`Unsupported workflow: ${workflow}`)
  if (!validator(input)) {
    const first = validator.errors?.[0]
    const location = first?.instancePath ? ` at ${first.instancePath}` : ''
    throw new Error(
      `Execution input does not match API ${EXECUTION_API_VERSION}${location}: ${first?.message ?? 'invalid input'}`,
    )
  }
}

export function validateExecutionResult(
  workflow: string,
  result: unknown,
): void {
  if (!resultValidators) {
    const root = schemasRoot()
    const ajv = new Ajv2020Module.default({ allErrors: true, strict: true })
    for (const name of readdirSync(root).filter((entry) =>
      entry.endsWith('.json'),
    )) {
      const schema = JSON.parse(
        readFileSync(path.join(root, name), 'utf8'),
      ) as AnySchemaObject
      ajv.addSchema(schema, name)
    }
    resultValidators = new Map(
      Object.entries(resultSchemaByWorkflow).map(([name, schemaName]) => {
        const validator = ajv.getSchema(schemaName)
        if (!validator)
          throw new Error(`Missing execution result schema: ${schemaName}`)
        return [name, validator]
      }),
    )
  }
  const validator = resultValidators.get(workflow)
  if (!validator) throw new Error(`Unsupported workflow: ${workflow}`)
  if (!validator(result)) {
    const first = validator.errors?.[0]
    const location = first?.instancePath ? ` at ${first.instancePath}` : ''
    throw new Error(
      `Execution result does not match API ${EXECUTION_API_VERSION}${location}: ${first?.message ?? 'invalid result'}`,
    )
  }
}
