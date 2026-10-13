// Generate the Control Plane data-shape JSON Schemas from the hand-written OpenAPI contract
// (`contracts/control-plane-api/openapi.yaml`). Each schema is committed to
// contracts/control-plane-api/v1/ and is a projection of the contract's `components.schemas`,
// so the console-fixture schemas and the contract cannot drift. Regenerate with
// `pnpm run generate:control-plane-schemas`.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
export const CONTROL_PLANE_ROOT = path.resolve(moduleDirectory, '..')
export const SPEC_PATH = path.resolve(
  CONTROL_PLANE_ROOT,
  '..',
  'contracts',
  'control-plane-api',
  'openapi.yaml'
)
export const SCHEMA_DIR = path.resolve(
  CONTROL_PLANE_ROOT,
  '..',
  'contracts',
  'control-plane-api',
  'v1'
)

const META_SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

function componentSchema(name: string): unknown {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as {
    components?: { schemas?: Record<string, unknown> }
  }
  const schema = spec.components?.schemas?.[name]
  if (schema === undefined) throw new Error(`openapi.yaml has no component schema ${name}`)
  return schema
}

/** Inline any local `#/components/schemas/…` references so the committed v1 file is a
 * self-contained JSON Schema (ajv validates it against its own `$id`, where those refs would
 * otherwise dangle). */
function inlineLocalRefs(node: unknown, schemas: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineLocalRefs(item, schemas))
  if (typeof node !== 'object' || node === null) return node
  const record = node as Record<string, unknown>
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/schemas/')) {
    const target = record.$ref.slice('#/components/schemas/'.length)
    const schema = schemas[target]
    if (schema === undefined) throw new Error(`dangling $ref to ${record.$ref}`)
    return inlineLocalRefs(schema, schemas)
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = inlineLocalRefs(value, schemas)
  }
  return out
}

function renderSchema(id: string, schema: unknown): string {
  return `${JSON.stringify({ $schema: META_SCHEMA, $id: id, ...(schema as object) }, null, 2)}\n`
}

export function renderObservedRunSchema(): string {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as {
    components?: { schemas?: Record<string, unknown> }
  }
  const inlined = inlineLocalRefs(componentSchema('ObservedRun'), spec.components?.schemas ?? {})
  return renderSchema(
    'https://sec-review-bot.local/contracts/control-plane-api/v1/observed-run.schema.json',
    inlined
  )
}

export function renderReviewRunRecordSchema(): string {
  const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as {
    components?: { schemas?: Record<string, unknown> }
  }
  const inlined = inlineLocalRefs(
    componentSchema('ReviewRunRecord'),
    spec.components?.schemas ?? {}
  )
  return renderSchema(
    'https://sec-review-bot.local/contracts/control-plane-api/v1/review-run-record.schema.json',
    inlined
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [filename, rendered] of [
    ['observed-run.schema.json', renderObservedRunSchema()],
    ['review-run-record.schema.json', renderReviewRunRecordSchema()]
  ] as const) {
    const output = path.join(SCHEMA_DIR, filename)
    writeFileSync(output, rendered)
    console.log(`Wrote ${path.relative(process.cwd(), output)}`)
  }
}
