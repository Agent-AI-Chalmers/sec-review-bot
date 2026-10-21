// `PublicationWork` is the full run record plus the publication claim.
//
// `ReviewRunStore.claimNextPublication` returns `{...rowToRecord(row), workflow_result,
// claim_token}`, so every field on `ReviewRunRecord` also appears in that response. The two
// schemas are written by hand, and #122 added `notices` to `ReviewRunRecord` without adding it
// to `PublicationWork`. Nothing failed until a run actually became publishable, and then the
// claim endpoint answered 500 with "The value of '#' does not match schema definition." —
// fast-json-stringify rejects the unknown property under `additionalProperties: false`.
//
// Deriving one schema from the other with OpenAPI `allOf` would prevent the drift at the source,
// but it does not serialize through this fastify + openapi-glue path: a payload that satisfies
// both branches still failed with the same "does not match schema definition" error. Keeping two
// explicit schemas and holding them together with this test is what was verified to work.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import { CONTROL_PLANE_API_SPEC_PATH as SPEC_PATH } from './generated-paths.js'

type Schema = {
  properties?: Record<string, unknown>
  required?: string[]
}
type Spec = { components?: { schemas?: Record<string, Schema> } }

const spec = parseYaml(readFileSync(SPEC_PATH, 'utf8')) as Spec

/** Fields the claim response adds on top of the stored record. */
const CLAIM_ONLY_FIELDS = new Set(['workflow_result', 'claim_token'])

function schemaOf(name: string): Schema {
  const schema = spec.components?.schemas?.[name]
  if (schema?.properties === undefined)
    throw new Error(`${name} has no properties`)
  return schema
}

function fieldsOf(schema: Schema): Set<string> {
  return new Set(Object.keys(schema.properties ?? {}))
}

function requiredOf(schema: Schema): Set<string> {
  return new Set(schema.required ?? [])
}

test('PublicationWork carries every ReviewRunRecord field plus the claim', () => {
  const record = schemaOf('ReviewRunRecord')
  const work = schemaOf('PublicationWork')

  const expectedFields = new Set([...fieldsOf(record), ...CLAIM_ONLY_FIELDS])
  const unexpectedFields = [...fieldsOf(work)].filter(
    (field) => !expectedFields.has(field)
  )
  const missingFields = [...expectedFields].filter(
    (field) => !fieldsOf(work).has(field)
  )

  // Requiredness must match too: a field present in both but required only on the record would
  // generate `notices?` here while the store always sends it, and the difference would only show
  // up in the generated type, not in the serialized payload.
  const expectedRequired = new Set([
    ...requiredOf(record),
    ...CLAIM_ONLY_FIELDS
  ])
  const unexpectedRequired = [...requiredOf(work)].filter(
    (field) => !expectedRequired.has(field)
  )
  const missingRequired = [...expectedRequired].filter(
    (field) => !requiredOf(work).has(field)
  )

  assert.deepEqual(
    {
      missingFields,
      unexpectedFields,
      missingRequired,
      unexpectedRequired
    },
    {
      missingFields: [],
      unexpectedFields: [],
      missingRequired: [],
      unexpectedRequired: []
    },
    'PublicationWork must stay the run record plus workflow_result and claim_token, ' +
      'with the same requiredness; the store builds it by spreading rowToRecord(row)'
  )
})
