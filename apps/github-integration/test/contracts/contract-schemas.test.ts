import assert from 'node:assert/strict'
import test from 'node:test'

import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js'

import {
  contractFixture,
  contractFixtureFiles,
  contractFixtureManifest,
  contractSchema,
  contractSchemaFiles
} from '../contract-fixtures.js'

interface FixtureManifest {
  schema_fixtures: Record<string, string>
  invalid_schema_fixtures: Record<string, string>
  invalid_fixture_error_paths: Record<string, string>
}

function invalidFixtureSchemas(): Array<[string, string]> {
  const manifest = contractFixtureManifest() as FixtureManifest
  assert.strictEqual(typeof manifest.invalid_schema_fixtures, 'object')
  return Object.entries(manifest.invalid_schema_fixtures)
}

function fixtureSchemas(): Array<[string, string]> {
  const manifest = contractFixtureManifest() as FixtureManifest
  assert.strictEqual(typeof manifest.schema_fixtures, 'object')
  return Object.entries(manifest.schema_fixtures)
}

function contractAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true })
  const commonSchema = contractSchema('common.schema.json') as AnySchemaObject

  ajv.addSchema(commonSchema)
  ajv.addSchema(commonSchema, 'common.schema.json')

  return ajv
}

function contractValidator(schemaName: string): ReturnType<Ajv2020['compile']> {
  const ajv = contractAjv()
  return ajv.compile(contractSchema(schemaName) as AnySchemaObject)
}

test('shared v6 contract fixtures match JSON schemas', () => {
  const ajv = contractAjv()
  const validators = new Map<string, ReturnType<Ajv2020['compile']>>()

  for (const [fixtureName, schemaName] of fixtureSchemas()) {
    let validate = validators.get(schemaName)
    if (validate === undefined) {
      validate = ajv.compile(contractSchema(schemaName) as AnySchemaObject)
      validators.set(schemaName, validate)
    }
    const valid = validate(contractFixture(fixtureName))

    assert.strictEqual(
      valid,
      true,
      `${fixtureName} failed ${schemaName}: ${ajv.errorsText(validate.errors)}`
    )
  }
})

test('shared v6 contract fixture manifest covers fixture and schema files', () => {
  const schemaFixtures = new Map(fixtureSchemas())
  const invalidSchemaFixtures = new Map(invalidFixtureSchemas())
  const fixtureNames = contractFixtureFiles().filter(
    (name) => name !== 'manifest.json'
  )
  const schemaNames = new Set(contractSchemaFiles())

  assert.deepStrictEqual(
    [...schemaFixtures.keys(), ...invalidSchemaFixtures.keys()].sort(),
    fixtureNames
  )
  assert.ok(
    [...schemaFixtures.values(), ...invalidSchemaFixtures.values()].every(
      (schemaName) => schemaNames.has(schemaName)
    )
  )
})

test('shared v6 invalid contract fixtures are rejected by JSON schemas', () => {
  const manifest = contractFixtureManifest() as FixtureManifest
  assert.deepStrictEqual(
    Object.keys(manifest.invalid_fixture_error_paths).sort(),
    Object.keys(manifest.invalid_schema_fixtures).sort(),
    'every invalid fixture must declare where it is expected to fail'
  )
  for (const [fixtureName, schemaName] of invalidFixtureSchemas()) {
    const validate = contractValidator(schemaName)
    validate(contractFixture(fixtureName))
    const allFailing = new Set(
      (validate.errors ?? []).map((error) =>
        error.instancePath === ''
          ? '<root>'
          : error.instancePath
              .slice(1)
              .split('/')
              .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
              .join('.')
      )
    )
    const failing = new Set(
      [...allFailing].filter(
        (candidate) =>
          ![...allFailing].some(
            (other) => other !== candidate && candidate.startsWith(`${other}.`)
          )
      )
    )
    assert.deepStrictEqual(
      failing,
      new Set([manifest.invalid_fixture_error_paths[fixtureName]]),
      `${fixtureName} should fail only at its declared path`
    )
  }
})

test('v6 pull request input schema requires audit objective', () => {
  const validate = contractValidator('pull-request-review-input.schema.json')
  const payload = contractFixture('pull-request-review-input.json') as {
    review_intent: { objective: string }
  }
  payload.review_intent.objective = 'repair'

  assert.strictEqual(validate(payload), false)
})

test('v6 repository input schema requires audit objective', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = contractFixture(
    'repository-review-input-incremental.json'
  ) as {
    review_intent: { objective: string }
  }
  payload.review_intent.objective = 'repair'

  assert.strictEqual(validate(payload), false)
})

test('v6 repository input schema rejects the removed max_file_bytes field', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = structuredClone(
    contractFixture('repository-review-input-full.json')
  ) as {
    scan_scope: { max_file_bytes?: number }
  }
  payload.scan_scope.max_file_bytes = 200000

  assert.strictEqual(validate(payload), false)
})

test('v6 repository full scan schema rejects incremental window fields', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = contractFixture('repository-review-input-full.json') as {
    scan_target: {
      base_sha: string | null
      commit_shas: string[]
    }
    scan_scope: {
      incremental_changed_files: Array<Record<string, unknown>>
    }
  }
  payload.scan_target.base_sha = '1111111111111111111111111111111111111111'
  payload.scan_target.commit_shas = ['1111111111111111111111111111111111111111']
  payload.scan_scope.incremental_changed_files = [
    { path: 'src/webhook.ts', status: 'modified', previous_path: null }
  ]

  assert.strictEqual(validate(payload), false)
})

test('v6 repository incremental schema rejects missing window fields', () => {
  const validate = contractValidator('repository-review-input.schema.json')

  for (const scanTargetPatch of [{ base_sha: null }, { commit_shas: [] }]) {
    const payload = structuredClone(
      contractFixture('repository-review-input-incremental.json')
    ) as {
      scan_target: {
        base_sha: string | null
        commit_shas: string[]
      }
    }
    Object.assign(payload.scan_target, scanTargetPatch)

    assert.strictEqual(
      validate(payload),
      false,
      JSON.stringify(scanTargetPatch)
    )
  }
})

test('v6 repository incremental schema allows empty changed file scope', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = structuredClone(
    contractFixture('repository-review-input-incremental.json')
  ) as {
    scan_scope: {
      incremental_changed_files: Array<Record<string, unknown>>
    }
  }
  payload.scan_scope.incremental_changed_files = []

  assert.strictEqual(validate(payload), true)
})

test('v6 review record schema rejects unsafe file change paths', () => {
  const validate = contractValidator('review-record.schema.json')

  for (const path of [
    '../src/server.ts',
    '/src/server.ts',
    'C:src/server.ts',
    'C:/src/server.ts',
    'src//server.ts',
    'src\\server.ts',
    '.git/config',
    ' src/server.ts '
  ]) {
    const payload = structuredClone(
      contractFixture('review-record-deleted-file.json')
    ) as {
      mitigation: {
        file_changes: Array<{ path: string }>
      }
    }
    const [fileChange] = payload.mitigation.file_changes
    assert.ok(fileChange)
    fileChange.path = path

    assert.strictEqual(
      validate(payload),
      false,
      `${path} should not be schema-valid`
    )
  }
})
