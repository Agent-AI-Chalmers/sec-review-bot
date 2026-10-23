// Project the integration contract's JSON Schemas into consumer-specific TypeScript declarations.
//
// The selected schemas under `contracts/integration-contract/<version>/schemas` are the
// hand-written source of
// truth for workflow transport shapes. The Control Plane and Execution Gateway need workflow
// inputs, while the GitHub integration also consumes review results. Hand-maintained copies are
// how those shapes drifted before; this generator projects only what each consumer needs.
//
// This is separate from `generate-types.ts`, which projects the Execution API from
// `openapi.yaml`: that describes the transport envelope, while these schemas describe the
// workflow-specific objects carried inside it.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { compile, type JSONSchema } from 'json-schema-to-typescript'
import prettier from 'prettier'

import type { GeneratedArtifact } from './generated-artifact.js'
import { REPO_ROOT } from './repo-root.js'

type JsonSchema = Record<string, unknown>

export const WORKFLOW_CONTRACT_VERSION = 'v6'

const SCHEMA_DIR = path.join(
  REPO_ROOT,
  'contracts',
  'integration-contract',
  WORKFLOW_CONTRACT_VERSION,
  'schemas'
)
const COMMON_SCHEMA = 'common.schema.json'

/**
 * The `common.schema.json` definitions that are projected as named TypeScript types, in the
 * order they are emitted.
 *
 * Every other definition in that file is a scalar refinement (`nonBlankString`, a pattern-bounded
 * string, and so on). Naming one would reference a type this generator never declares, so they
 * are inlined where they are used.
 */
const NAMED_COMMON_DEFS = new Map<string, string>([
  ['inputBundleArtifactRef', 'InputBundleArtifactRef'],
  ['reviewIntent', 'ReviewIntent'],
  ['scanTarget', 'RepositoryScanTarget'],
  ['scanScope', 'RepositoryScanScope'],
  ['fileChange', 'FileChange'],
  ['reviewRecord', 'ReviewRecord']
])

const WORKFLOW_INPUT_COMMON_DEFS = [
  'inputBundleArtifactRef',
  'reviewIntent',
  'scanTarget',
  'scanScope'
] as const

/** Workflow input schemas projected into the integration's input contract. */
const WORKFLOW_INPUTS = [
  {
    schema: 'issue-review-input.schema.json',
    interface: 'IssueReviewInput'
  },
  {
    schema: 'pull-request-review-input.schema.json',
    interface: 'PullRequestReviewInput'
  },
  {
    schema: 'repository-review-input.schema.json',
    interface: 'RepositoryReviewInput'
  }
] as const

function readSchema(file: string): JsonSchema {
  return JSON.parse(
    readFileSync(path.join(SCHEMA_DIR, file), 'utf8')
  ) as JsonSchema
}

function defsOf(document: JsonSchema): Record<string, JsonSchema> {
  const defs = document.$defs
  return typeof defs === 'object' && defs !== null
    ? (defs as Record<string, JsonSchema>)
    : {}
}

/**
 * Resolve a `$defs` reference to the definition name it points at.
 *
 * Both forms appear: `common.schema.json#/$defs/x` from a workflow schema, and the same-file
 * `#/$defs/x` used inside `common.schema.json` itself.
 */
function commonDefName(ref: unknown, where: string): string {
  if (typeof ref !== 'string') {
    throw new Error(`${where}: expected a $ref string`)
  }
  const match = /^(?:common\.schema\.json)?#\/\$defs\/(.+)$/.exec(ref)
  if (match?.[1] === undefined) {
    throw new Error(`${where}: unsupported $ref ${ref}`)
  }
  return match[1]
}

/**
 * Prepare a schema for the TypeScript compiler.
 *
 * Named common definitions stay named through json-schema-to-typescript's `tsType` extension.
 * Scalar refinements are inlined because TypeScript cannot represent their runtime constraints.
 * `allOf` branches in this contract narrow cross-field modes; Ajv enforces those rules, while the
 * compile-time projection intentionally keeps one stable transport shape for producers.
 */
function projectSchema(value: unknown, common: JsonSchema): unknown {
  if (Array.isArray(value))
    return value.map((item) => projectSchema(item, common))
  if (typeof value !== 'object' || value === null) return value

  const node = value as JsonSchema
  if (node.$ref !== undefined) {
    const defName = commonDefName(node.$ref, 'schema projection')
    const named = NAMED_COMMON_DEFS.get(defName)
    if (named !== undefined) return { tsType: named }
    const target = defsOf(common)[defName]
    if (target === undefined) {
      throw new Error(`common.schema.json has no $defs.${defName}`)
    }
    return projectSchema(target, common)
  }
  if (
    node.type === 'object' &&
    node.properties === undefined &&
    node.additionalProperties !== false
  ) {
    return { tsType: 'Record<string, unknown>' }
  }

  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'allOf' && key !== 'maxItems')
      .map(([key, child]) => [key, projectSchema(child, common)])
  )
}

async function compileDeclaration(
  name: string,
  schema: JsonSchema,
  common: JsonSchema
): Promise<string> {
  const projected = projectSchema(schema, common)
  if (typeof projected !== 'object' || projected === null) {
    throw new Error(`${name}: expected an object schema`)
  }
  return (
    await compile({ ...projected, title: name } as JSONSchema, name, {
      bannerComment: '',
      enableConstEnums: false,
      format: false,
      ignoreMinAndMaxItems: true,
      unknownAny: true
    })
  ).trim()
}

function assertReviewRecordSchema(common: JsonSchema): void {
  const schema = readSchema('review-record.schema.json')
  const defName = commonDefName(schema.$ref, 'ReviewRecord')
  if (defName !== 'reviewRecord' || defsOf(common)[defName] === undefined) {
    throw new Error(
      'review-record.schema.json must reference common.schema.json#/$defs/reviewRecord'
    )
  }
}

/**
 * Collect every `maxItems` the schemas declare, as named limits.
 *
 * A producer that inlines a list into the workflow input needs the bound before the input is
 * built, so it can fail with a message that names the limit. Restating the number in TypeScript
 * would make the schema stop being the only place the boundary is defined.
 */
function renderLimits(): string {
  const limits: string[] = []
  const seen = new Set<string>()
  const visit = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, path))
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      const next = [...path, key]
      if (LIMIT_KEYS.has(key) && typeof value === 'number') {
        const name = limitName(path)
        if (name !== null && !seen.has(name)) {
          seen.add(name)
          limits.push(`export const ${name} = ${value}`)
        }
        continue
      }
      // A `$defs` entry whose body is a single `const` states a limit directly, for bounds that
      // no JSON Schema keyword can express (a serialized byte size, for instance).
      if (
        key === 'const' &&
        typeof value === 'number' &&
        path.length === 2 &&
        path[0] === '$defs'
      ) {
        const name = limitName([path[1] as string])
        if (name !== null && !seen.has(name)) {
          seen.add(name)
          limits.push(`export const ${name} = ${value}`)
        }
        continue
      }
      visit(value, next)
    }
  }
  visit(readSchema(COMMON_SCHEMA), [])
  for (const { schema } of WORKFLOW_INPUTS) {
    visit(readSchema(schema), [])
  }
  return limits.join('\n')
}

/**
 * Name a limit after the fields it applies to.
 *
 * `["properties", "pr", "properties", "commit_shas", "maxItems"]` becomes
 * `MAX_PR_COMMIT_SHAS`. Structural keys (`properties`, `$defs`, `allOf`, `then`) and the
 * `maxItems` keyword itself carry no meaning for a caller, so they are dropped. An `allOf`
 * branch states a constraint for one mode rather than a bound a producer can check up front, so
 * those are skipped.
 */
// The schema keywords whose numeric value a producer needs before it builds the input.
const LIMIT_KEYS = new Set(['maxItems', 'maxLength'])

const STRUCTURAL_KEYS = new Set([
  'properties',
  'items',
  'maxItems',
  'maxLength',
  '$defs',
  'allOf',
  'anyOf',
  'oneOf',
  'if',
  'then',
  'else'
])

function limitName(path: string[]): string | null {
  if (
    path.some((part) => part === 'allOf' || part === 'if' || part === 'then')
  ) {
    return null
  }
  const parts = path.filter((part) => !STRUCTURAL_KEYS.has(part))
  if (parts.length === 0) return null
  return `MAX_${parts
    .join('_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase()}`
}

export async function renderIntegrationContractDeclarations(): Promise<string> {
  const common = readSchema(COMMON_SCHEMA)
  assertReviewRecordSchema(common)
  return await renderDeclarations(common, NAMED_COMMON_DEFS.keys())
}

function renderWorkflowName(): string {
  const suffix = '-input.schema.json'
  const workflows = WORKFLOW_INPUTS.map(({ schema }) => {
    if (!schema.endsWith(suffix)) {
      throw new Error(
        `workflow input schema must end with ${suffix}: ${schema}`
      )
    }
    return schema.slice(0, -suffix.length)
  })
  return `export type WorkflowName = ${workflows.map((workflow) => `'${workflow}'`).join(' | ')}`
}

export async function renderWorkflowInputDeclarations(): Promise<string> {
  const common = readSchema(COMMON_SCHEMA)
  return await renderDeclarations(common, WORKFLOW_INPUT_COMMON_DEFS)
}

async function renderDeclarations(
  common: JsonSchema,
  commonDefNames: Iterable<string>
): Promise<string> {
  const defs = defsOf(common)
  const commonTypes = await Promise.all(
    [...commonDefNames].map(async (defName) => {
      const name = NAMED_COMMON_DEFS.get(defName)
      if (name === undefined) {
        throw new Error(`common definition ${defName} has no TypeScript name`)
      }
      const schema = defs[defName]
      if (schema === undefined) {
        throw new Error(`common.schema.json has no $defs.${defName}`)
      }
      return await compileDeclaration(name, schema, common)
    })
  )
  const inputs = await Promise.all(
    WORKFLOW_INPUTS.map(
      async ({ schema, interface: name }) =>
        await compileDeclaration(name, readSchema(schema), common)
    )
  )
  return [...commonTypes, ...inputs].join('\n\n')
}

async function renderFile(): Promise<string> {
  return [
    `// Generated from contracts/integration-contract/${WORKFLOW_CONTRACT_VERSION}/schemas. Do not edit by hand.`,
    '// Regenerate with `pnpm --dir contracts/integration-contract/tools run generate`.',
    '',
    renderWorkflowName(),
    '',
    await renderIntegrationContractDeclarations(),
    '',
    renderLimits(),
    ''
  ].join('\n')
}

function gatewayVersionOutput(): string {
  return path.join(REPO_ROOT, 'execution-gateway', 'src', 'contract-version.ts')
}

function integrationVersionOutput(): string {
  return path.join(
    REPO_ROOT,
    'apps',
    'github-integration',
    'src',
    'execution',
    'contract-version.ts'
  )
}

async function renderGatewayVersion(output: string): Promise<string> {
  const rendered = [
    `// Generated from the integration-contract projection selected by contracts/integration-contract/tools/src/generate-integration-types.ts. Do not edit.`,
    '// Regenerate with `pnpm --dir contracts/integration-contract/tools run generate`.',
    '',
    `export const WORKFLOW_CONTRACT_VERSION = '${WORKFLOW_CONTRACT_VERSION}' as const`,
    ''
  ].join('\n')
  const options = await prettier.resolveConfig(output)
  return await prettier.format(rendered, { ...options, filepath: output })
}

async function renderIntegrationVersion(output: string): Promise<string> {
  const rendered = [
    `// Generated from the integration-contract projection selected by contracts/integration-contract/tools/src/generate-integration-types.ts. Do not edit.`,
    '// Regenerate with `pnpm --dir contracts/integration-contract/tools run generate`.',
    '',
    `export const CONTRACT_VERSION = '${WORKFLOW_CONTRACT_VERSION}' as const`,
    '',
    'export type ContractVersion = typeof CONTRACT_VERSION',
    ''
  ].join('\n')
  const options = await prettier.resolveConfig(output)
  return await prettier.format(rendered, { ...options, filepath: output })
}

function inputTypesOutput(): string {
  return path.join(
    REPO_ROOT,
    'apps',
    'github-integration',
    'src',
    'execution',
    'integration-contract-types-generated.ts'
  )
}

export function generatedArtifacts(): GeneratedArtifact[] {
  const integrationTypesOutput = inputTypesOutput()
  const gatewayVersion = gatewayVersionOutput()
  const integrationVersion = integrationVersionOutput()
  return [
    {
      output: integrationTypesOutput,
      render: async () => {
        const options = await prettier.resolveConfig(integrationTypesOutput)
        return await prettier.format(await renderFile(), {
          ...options,
          filepath: integrationTypesOutput
        })
      }
    },
    {
      output: gatewayVersion,
      render: async () => await renderGatewayVersion(gatewayVersion)
    },
    {
      output: integrationVersion,
      render: async () => await renderIntegrationVersion(integrationVersion)
    }
  ]
}
