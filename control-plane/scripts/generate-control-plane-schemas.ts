// Generate the Control Plane data-shape JSON Schemas from the TypeBox schemas in
// `src/shapes.ts`. Each schema is committed to contracts/control-plane-api/v1/ and is a
// projection of a single TypeBox source, so the type, the schema, and runtime validation
// cannot drift. Regenerate with `pnpm run generate:control-plane-schemas`.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ObservedRunSchema, ReviewRunRecordSchema } from '../src/shapes.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
export const CONTROL_PLANE_ROOT = path.resolve(moduleDirectory, '..')
export const SCHEMA_DIR = path.resolve(
  CONTROL_PLANE_ROOT,
  '..',
  'contracts',
  'control-plane-api',
  'v1'
)

const META_SCHEMA = 'https://json-schema.org/draft/2020-12/schema'

function renderSchema(id: string, schema: unknown): string {
  // JSON round-trip drops TypeBox's `[Kind]` symbol and any non-serializable metadata.
  const plain = JSON.parse(JSON.stringify(schema)) as object
  return `${JSON.stringify({ $schema: META_SCHEMA, $id: id, ...plain }, null, 2)}\n`
}

export function renderObservedRunSchema(): string {
  return renderSchema(
    'https://sec-review-bot.local/contracts/control-plane-api/v1/observed-run.schema.json',
    ObservedRunSchema
  )
}

export function renderReviewRunRecordSchema(): string {
  return renderSchema(
    'https://sec-review-bot.local/contracts/control-plane-api/v1/review-run-record.schema.json',
    ReviewRunRecordSchema
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
