import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  Ajv2020,
  type AnySchemaObject,
  type ValidateFunction
} from 'ajv/dist/2020.js'

import type { WorkflowName } from './execution-api-types-generated.js'
import { EXECUTION_API_VERSION } from './execution-api-version.js'

const RESULT_SCHEMA_BY_WORKFLOW: Record<WorkflowName, string> = {
  'issue-review': 'issue-review-result.schema.json',
  'pull-request-review': 'pull-request-review-result.schema.json',
  'repository-review': 'repository-review-result.schema.json'
}

const INPUT_BUNDLE_MANIFEST_SCHEMA = 'input-bundle-manifest.schema.json'

let validators: Map<string, ValidateFunction> | null = null

function executionApiSchemasRoot(): string {
  const configuredRoot = process.env.SEC_REVIEW_CONTRACTS_ROOT
  if (configuredRoot !== undefined) {
    const root = path.resolve(
      configuredRoot,
      'execution-api',
      EXECUTION_API_VERSION,
      'schemas'
    )
    if (!existsSync(path.join(root, 'common.schema.json'))) {
      throw new Error(
        `SEC_REVIEW_CONTRACTS_ROOT=${configuredRoot} does not contain execution-api/${EXECUTION_API_VERSION}/schemas/common.schema.json.`
      )
    }
    return root
  }

  const candidates = [
    path.resolve(
      process.cwd(),
      'contracts',
      'execution-api',
      EXECUTION_API_VERSION,
      'schemas'
    ),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      'contracts',
      'execution-api',
      EXECUTION_API_VERSION,
      'schemas'
    )
  ]
  const root = candidates.find((candidate) =>
    existsSync(path.join(candidate, 'common.schema.json'))
  )
  if (root === undefined) {
    throw new Error(
      `Could not locate contract ${EXECUTION_API_VERSION} schemas for execution validation.`
    )
  }
  return root
}

function readSchema(root: string, name: string): AnySchemaObject {
  return JSON.parse(
    readFileSync(path.join(root, name), 'utf8')
  ) as AnySchemaObject
}

function resultValidators(): Map<string, ValidateFunction> {
  if (validators !== null) {
    return validators
  }

  const root = executionApiSchemasRoot()
  const ajv = new Ajv2020({ allErrors: true })
  const commonSchema = readSchema(root, 'common.schema.json')
  ajv.addSchema(commonSchema)

  validators = new Map<string, ValidateFunction>([
    [
      'review-record.schema.json',
      ajv.compile(readSchema(root, 'review-record.schema.json'))
    ],
    [
      INPUT_BUNDLE_MANIFEST_SCHEMA,
      ajv.compile(readSchema(root, INPUT_BUNDLE_MANIFEST_SCHEMA))
    ],
    ...Object.values(RESULT_SCHEMA_BY_WORKFLOW).map(
      (name): [string, ValidateFunction] => [
        name,
        ajv.compile(readSchema(root, name))
      ]
    )
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
      ?.map(
        (error) =>
          `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
      )
      .join('; ')
    throw new Error(
      `${label} does not match API ${EXECUTION_API_VERSION}${details ? `: ${details}` : '.'}`
    )
  }
}

/**
 * Validate a workflow result against the current API version's result schema.
 *
 * Version-independent by name: the schema is selected from
 * `EXECUTION_API_VERSION`, so this function tracks API version changes without a rename.
 */
export function assertWorkflowResult(
  workflow: WorkflowName,
  value: unknown
): void {
  assertSchema(RESULT_SCHEMA_BY_WORKFLOW[workflow], value, `${workflow} result`)
}

/** Validate a review record against the current API version's review-record schema. */
export function assertReviewRecord(value: unknown): void {
  assertSchema('review-record.schema.json', value, 'review_record')
}

/** Validate an input bundle manifest before publishing its archive. */
export function assertInputBundleManifest(value: unknown): void {
  assertSchema(INPUT_BUNDLE_MANIFEST_SCHEMA, value, 'input bundle manifest')
}

/**
 * Force-load the contract validators so a missing or unreadable schema set fails
 * at startup rather than on the first result published. The service packages the
 * schemas into its image; a build that copied the wrong ones should not start.
 */
export function verifyContractSchemasLoadable(): void {
  resultValidators()
}
