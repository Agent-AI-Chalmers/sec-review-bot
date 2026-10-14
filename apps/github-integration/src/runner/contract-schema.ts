import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js'

import type { WorkflowName } from './shapes.js'
import { CONTRACT_VERSION_DIR } from './contract-version.js'

const RESULT_SCHEMA_BY_WORKFLOW: Record<WorkflowName, string> = {
  'issue-review': 'issue-review-result.schema.json',
  'pull-request-review': 'pull-request-review-result.schema.json',
  'repository-review': 'repository-review-result.schema.json'
}

let validators: Map<string, ValidateFunction> | null = null

function contractSchemasRoot(): string {
  const configuredRoot = process.env.SEC_REVIEW_CONTRACTS_ROOT
  const candidates = [
    ...(configuredRoot
      ? [path.resolve(configuredRoot, 'integration-contract', CONTRACT_VERSION_DIR, 'schemas')]
      : []),
    path.resolve(
      process.cwd(),
      'contracts',
      'integration-contract',
      CONTRACT_VERSION_DIR,
      'schemas'
    ),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      'contracts',
      'integration-contract',
      CONTRACT_VERSION_DIR,
      'schemas'
    )
  ]
  const root = candidates.find((candidate) =>
    existsSync(path.join(candidate, 'common.schema.json'))
  )
  if (root === undefined) {
    throw new Error(
      `Could not locate contract ${CONTRACT_VERSION_DIR} schemas for Runner validation.`
    )
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

  validators = new Map<string, ValidateFunction>([
    ['review-record.schema.json', ajv.compile(readSchema(root, 'review-record.schema.json'))],
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
    throw new Error(`${label} does not match contract v6${details ? `: ${details}` : '.'}`)
  }
}

export function assertV5WorkflowResult(workflow: WorkflowName, value: unknown): void {
  assertSchema(RESULT_SCHEMA_BY_WORKFLOW[workflow], value, `${workflow} result`)
}

export function assertV5ReviewRecord(value: unknown): void {
  assertSchema('review-record.schema.json', value, 'review_record')
}
