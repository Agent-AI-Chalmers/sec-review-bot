// Generate the Control Plane data-shape JSON Schemas from the hand-written OpenAPI contract
// (`contracts/control-plane-api/openapi.yaml`). Each schema is committed to
// contracts/control-plane-api/v1/ and is a projection of the contract's `components.schemas`,
// so the console-fixture schemas and the contract cannot drift. Regenerate with
// `pnpm --dir contracts/control-plane-api/tools run generate`.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { GeneratedArtifact } from './generated-artifact.js'
import { REPO_ROOT } from './repo-root.js'

export { REPO_ROOT }
export const SPEC_PATH = path.resolve(REPO_ROOT, 'contracts', 'control-plane-api', 'openapi.yaml')
export const SCHEMA_DIR = path.resolve(REPO_ROOT, 'contracts', 'control-plane-api', 'v1')

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
 * otherwise dangle).
 *
 * A `$ref` carrying sibling keywords is rejected rather than silently reduced to its target.
 * JSON Schema ignores those siblings, but this generator would *drop* them, so a rule like
 * `description`, `nullable`, or `default` written beside a `$ref` would vanish from the
 * committed schema without a word — the schema would then accept or describe something other
 * than what openapi.yaml says. Nothing in the current contract does this, so failing loudly
 * costs nothing today and prevents a silent mistranslation later. */
function inlineLocalRefs(node: unknown, schemas: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineLocalRefs(item, schemas))
  if (typeof node !== 'object' || node === null) return node
  const record = node as Record<string, unknown>
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/schemas/')) {
    const siblings = Object.keys(record).filter((key) => key !== '$ref')
    if (siblings.length > 0) {
      throw new Error(
        `$ref ${record.$ref} has sibling keywords (${siblings.join(', ')}); this generator ` +
          'would drop them. Inline the target or move the keywords into it.'
      )
    }
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

/** Exposed for the guard tests, which pin the two inputs this would otherwise mistranslate
 * silently. Not used by the render functions, which call it through the local binding. */
export const inlineLocalRefsForTest = inlineLocalRefs

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

/** The schemas this generator writes, each with the renderer that produces it. This one table
 * is both what the CLI writes and what the generated-artifacts manifest is checked against, so
 * the two cannot disagree. */
const GENERATED_SCHEMAS = [
  ['observed-run.schema.json', renderObservedRunSchema],
  ['review-run-record.schema.json', renderReviewRunRecordSchema]
] as const satisfies ReadonlyArray<readonly [string, () => string]>

/** The schema file names under {@link SCHEMA_DIR}, for the manifest check. */
export const SCHEMA_FILENAMES = GENERATED_SCHEMAS.map(([filename]) => filename)

/** This generator's outputs as the shared descriptor the checker walks. */
export function generatedArtifacts(): GeneratedArtifact[] {
  return GENERATED_SCHEMAS.map(([filename, render]) => ({
    output: path.join(SCHEMA_DIR, filename),
    render
  }))
}
