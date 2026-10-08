import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js'

import type { WorkflowName } from './client.js'

const RESULT_SCHEMA_BY_WORKFLOW: Record<WorkflowName, string> = {
  'issue-review': 'issue-review-result.schema.json',
  'pull-request-review': 'pull-request-review-result.schema.json',
  'repository-review': 'repository-review-result.schema.json'
}

const INPUT_SCHEMA_BY_WORKFLOW: Record<WorkflowName, string> = {
  'issue-review': 'issue-review-input.schema.json',
  'pull-request-review': 'pull-request-review-input.schema.json',
  'repository-review': 'repository-review-input.schema.json'
}

let validators: Map<string, ValidateFunction> | null = null

function contractSchemasRoot(): string {
  const configuredRoot = process.env.SEC_REVIEW_CONTRACTS_ROOT
  const candidates = [
    ...(configuredRoot ? [path.resolve(configuredRoot, 'schemas', 'v5')] : []),
    path.resolve(process.cwd(), 'contracts', 'schemas', 'v5'),
    path.resolve(process.cwd(), '..', '..', 'contracts', 'schemas', 'v5')
  ]
  const root = candidates.find((candidate) =>
    existsSync(path.join(candidate, 'common.schema.json'))
  )
  if (root === undefined) {
    throw new Error('Could not locate contract v5 schemas for Runner validation.')
  }
  return root
}

function readSchema(root: string, name: string): AnySchemaObject {
  return JSON.parse(readFileSync(path.join(root, name), 'utf8')) as AnySchemaObject
}

function resultValidators(): Map<string, ValidateFunction> {
  if (validators !== null) {
    return validators
  }

  const root = contractSchemasRoot()
  const ajv = new Ajv2020({ allErrors: true })
  const commonSchema = readSchema(root, 'common.schema.json')
  ajv.addSchema(commonSchema)
  ajv.addSchema(commonSchema, 'common.schema.json')

  validators = new Map<string, ValidateFunction>([
    ['review-record.schema.json', ajv.compile(readSchema(root, 'review-record.schema.json'))],
    ...Object.values(INPUT_SCHEMA_BY_WORKFLOW).map((name): [string, ValidateFunction] => [
      name,
      ajv.compile(readSchema(root, name))
    ]),
    ...Object.values(RESULT_SCHEMA_BY_WORKFLOW).map((name): [string, ValidateFunction] => [
      name,
      ajv.compile(readSchema(root, name))
    ])
  ])
  return validators
}

function assertSchema(schemaName: string, value: unknown, label: string): void {
  const validate = resultValidators().get(schemaName)
  if (validate === undefined) {
    throw new Error(`Contract validator is not configured for ${schemaName}.`)
  }
  if (!validate(value)) {
    const details = validate.errors
      ?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ')
    throw new Error(`${label} does not match contract v5${details ? `: ${details}` : '.'}`)
  }
}

export function assertV5WorkflowResult(workflow: WorkflowName, value: unknown): void {
  assertSchema(RESULT_SCHEMA_BY_WORKFLOW[workflow], value, `${workflow} result`)
}

export function assertV5WorkflowInput(workflow: WorkflowName, value: unknown): void {
  assertSchema(INPUT_SCHEMA_BY_WORKFLOW[workflow], value, `${workflow} input`)
}

export function assertV5ReviewRecord(value: unknown): void {
  assertSchema('review-record.schema.json', value, 'review_record')
}
