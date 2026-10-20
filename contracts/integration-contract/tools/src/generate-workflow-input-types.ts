// Project the integration contract's workflow input JSON Schemas into TypeScript types.
//
// The schemas under `contracts/integration-contract/v6/schemas` are the hand-written source of
// truth for the workflow `input` transport shape. The GitHub integration needs those shapes in
// TypeScript, and a hand-maintained copy is how the producer's field names drifted away from
// them; this generator makes the integration's types a projection instead.
//
// This is separate from `generate-types.ts`, which projects the runner HTTP API from
// `openapi.json`: that describes the transport envelope, while these describe the workflow
// `input` object carried inside it.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { GeneratedArtifact } from './generated-artifact.js'
import { REPO_ROOT } from './repo-root.js'

/** The print width the owning package's prettier config uses. */
const PRINT_WIDTH = 80


type JsonSchema = Record<string, unknown>

const SCHEMA_DIR = path.join(
  REPO_ROOT,
  'contracts',
  'integration-contract',
  'v6',
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
  ['scanScope', 'RepositoryScanScope']
])

/** Workflow input schemas projected into the integration's input contract. */
const WORKFLOW_INPUTS = [
  { schema: 'issue-review-input.schema.json', interface: 'IssueReviewInput' },
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

/** Render a literal JSON value as a TypeScript literal type. */
/**
 * Render a JSON value as a TypeScript literal.
 *
 * Strings use single quotes to match the owning package's formatting, and a single-quoted string
 * needs no escaping change: the contract's literals contain no quotes or backslashes, and a value
 * that does is rejected rather than silently escaped differently from what this file promises.
 */
function literal(value: unknown): string {
  if (typeof value === 'string') {
    if (/['\\\n\r]/.test(value)) {
      throw new Error(
        `contract literal ${JSON.stringify(value)} needs escaping this generator does not model`
      )
    }
    return `'${value}'`
  }
  const rendered = JSON.stringify(value)
  if (rendered === undefined) {
    throw new Error('expected a JSON-serializable literal')
  }
  return rendered
}

function renderType(
  schema: unknown,
  indent: string,
  common: JsonSchema,
  where: string
): string {
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`${where}: expected a JSON Schema object`)
  }
  const node = schema as JsonSchema

  if (node.$ref !== undefined) {
    const defName = commonDefName(node.$ref, where)
    const named = NAMED_COMMON_DEFS.get(defName)
    if (named !== undefined) return named
    const target = defsOf(common)[defName]
    if (target === undefined) {
      throw new Error(`${where}: common.schema.json has no $defs.${defName}`)
    }
    return renderType(target, indent, common, `${where}>$defs.${defName}`)
  }
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(' | ')
  if ('const' in node) return literal(node.const)

  // `oneOf` and `anyOf` both mean "one of these shapes", which is a TypeScript union.
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const variants = node[keyword]
    if (Array.isArray(variants)) {
      const rendered = variants.map((variant, index) =>
        renderType(variant, indent, common, `${where}.${keyword}[${index}]`)
      )
      return [...new Set(rendered)].join(' | ')
    }
  }

  const type = node.type
  if (Array.isArray(type)) {
    return [
      ...new Set(
        type.map((entry) =>
          renderType(
            { ...node, type: entry },
            indent,
            common,
            `${where}|${String(entry)}`
          )
        )
      )
    ].join(' | ')
  }

  switch (type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const items = node.items
      if (items === undefined) return 'unknown[]'
      const rendered = renderType(items, indent, common, `${where}[]`)
      // Parenthesize only a top-level union. A single type binds tighter than `[]` already, and
      // wrapping it (`({...})[]`) would not match the owning package's formatting.
      const isUnion =
        rendered.startsWith('{') || rendered.startsWith('(')
          ? false
          : rendered.includes(' | ')
      return isUnion ? `(${rendered})[]` : `${rendered}[]`
    }
    case 'object':
      return renderObject(node, indent, common, where)
    default:
      throw new Error(
        `${where}: schema node has no resolvable type (${JSON.stringify(node).slice(0, 120)})`
      )
  }
}

function renderObject(
  node: JsonSchema,
  indent: string,
  common: JsonSchema,
  where: string
): string {
  const properties = node.properties
  if (typeof properties !== 'object' || properties === null) {
    return 'Record<string, unknown>'
  }
  const required = new Set(
    Array.isArray(node.required) ? (node.required as string[]) : []
  )
  const inner = `${indent}  `
  const lines = Object.entries(properties as Record<string, unknown>).map(
    ([key, value]) => {
      const optional = required.has(key) ? '' : '?'
      const keyText = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
        ? key
        : literal(key)
      const rendered = renderType(value, inner, common, `${where}.${key}`)
      const inline = `${inner}${keyText}${optional}: ${rendered}`
      // Keep the emitted text within the print width the owning package formats to. Only a union
      // that is otherwise on one line can be moved to its own line; an object already spans
      // lines and carries its own indentation.
      const isInlineUnion = !rendered.includes('\n') && rendered.includes(' | ')
      if (inline.length <= PRINT_WIDTH || !isInlineUnion) {
        return inline
      }
      return `${inner}${keyText}${optional}:\n${inner}  ${rendered}`
    }
  )
  if (lines.length === 0) return 'Record<string, unknown>'
  return `{\n${lines.join('\n')}\n${indent}}`
}

/**
 * Merge an `allOf` into one object shape.
 *
 * The workflow input schemas use `allOf` for two things this projection cannot carry: a
 * narrower `review_intent.objective` constant, and `if`/`then` rules such as "in `full` mode
 * `base_sha` is null". Both stay enforced by the JSON Schema at the process boundary, so they
 * are skipped here rather than mistranslated into a type that means something else.
 */
function mergeAllOf(schema: JsonSchema, where: string): JsonSchema {
  const members = schema.allOf
  const merged: JsonSchema = {
    type: 'object',
    properties: { ...((schema.properties as object) ?? {}) },
    required: [...((schema.required as string[]) ?? [])]
  }
  if (!Array.isArray(members)) return merged
  for (const [index, member] of members.entries()) {
    const memberNode = member as JsonSchema
    if (memberNode.if !== undefined) continue
    for (const key of Object.keys(memberNode)) {
      if (key !== 'properties' && key !== 'required' && key !== 'type') {
        throw new Error(`${where}.allOf[${index}]: unsupported keyword ${key}`)
      }
    }
    const memberProperties =
      (memberNode.properties as Record<string, unknown>) ?? {}
    const mergedProperties = merged.properties as Record<string, unknown>
    for (const [key, value] of Object.entries(memberProperties)) {
      // Keep an existing property's `$ref`: it is what gives the property its name. The
      // narrowing a member applies is a cross-field rule the schema still enforces.
      if (mergedProperties[key] === undefined) mergedProperties[key] = value
    }
    merged.required = [
      ...new Set([
        ...(merged.required as string[]),
        ...((memberNode.required as string[]) ?? [])
      ])
    ]
  }
  return merged
}

function renderInterface(
  name: string,
  schema: JsonSchema,
  common: JsonSchema
): string {
  const node = Array.isArray(schema.allOf) ? mergeAllOf(schema, name) : schema
  const body = renderObject(node, '', common, name)
  const withBrace = body.startsWith('{') ? body : `{ ${body} }`
  return `export interface ${name} ${withBrace}`
}

function renderCommonTypes(common: JsonSchema): string {
  const defs = defsOf(common)
  return [...NAMED_COMMON_DEFS]
    .map(([defName, typeName]) => {
      const schema = defs[defName]
      if (schema === undefined) {
        throw new Error(`common.schema.json has no $defs.${defName}`)
      }
      return renderInterface(typeName, schema, common)
    })
    .join('\n\n')
}

function renderFile(): string {
  const common = readSchema(COMMON_SCHEMA)
  const inputs = WORKFLOW_INPUTS.map(({ schema, interface: name }) =>
    renderInterface(name, readSchema(schema), common)
  )
  return [
    '// Generated from contracts/integration-contract/v6/schemas. Do not edit by hand.',
    '// Regenerate with `pnpm --dir contracts/integration-contract/tools run generate`.',
    '',
    renderCommonTypes(common),
    '',
    inputs.join('\n\n'),
    ''
  ].join('\n')
}

function inputTypesOutput(): string {
  return path.join(
    REPO_ROOT,
    'apps',
    'github-integration',
    'src',
    'runner',
    'integration-contract-types-generated.ts'
  )
}

export function generatedArtifacts(): GeneratedArtifact[] {
  return [
    {
      output: inputTypesOutput(),
      // The renderer emits text that already satisfies the owning package's formatting: two-space
      // indentation, no semicolons, single quotes, and no trailing commas. Running prettier here
      // would make the artifact depend on a second input (`prettierrc`), so the same contract
      // would produce different files per package and a formatting change would look like a
      // contract change.
      render: () => renderFile()
    }
  ]
}
