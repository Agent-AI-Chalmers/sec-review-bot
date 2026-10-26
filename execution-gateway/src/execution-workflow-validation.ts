import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020Module, { type ValidateFunction } from 'ajv/dist/2020.js'

interface ExecutionWorkflowInputSchema {
  'x-temporal-workflow-type': string
}

let validator: ValidateFunction | undefined

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

function schema(): Record<string, unknown> & ExecutionWorkflowInputSchema {
  const schemaPath = path.join(
    contractsRoot(),
    'execution-workflow',
    'v1',
    'execution-workflow-input.schema.json',
  )
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<
    string,
    unknown
  > &
    ExecutionWorkflowInputSchema
}

export function executionWorkflowType(): string {
  return schema()['x-temporal-workflow-type']
}

export function validateExecutionWorkflowInput(value: unknown): void {
  if (!validator) {
    const ajv = new Ajv2020Module.default({ allErrors: true, strict: true })
    ajv.addKeyword({
      keyword: 'x-temporal-workflow-type',
      schemaType: 'string',
      valid: true,
    })
    validator = ajv.compile(schema())
  }
  if (!validator(value)) {
    const first = validator.errors?.[0]
    throw new Error(
      `Execution Workflow input does not match execution-workflow/v1: ${first?.instancePath || '<root>'} ${first?.message ?? 'is invalid'}`,
    )
  }
}
