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
}

function fixtureSchemas (): Array<[string, string]> {
  const manifest = contractFixtureManifest('v4') as FixtureManifest
  assert.equal(typeof manifest.schema_fixtures, 'object')
  return Object.entries(manifest.schema_fixtures)
}

function contractAjv (): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true })
  const commonSchema = contractSchema('v4', 'common.schema.json') as AnySchemaObject

  ajv.addSchema(commonSchema)
  ajv.addSchema(commonSchema, 'common.schema.json')

  return ajv
}

function contractValidator (schemaName: string): ReturnType<Ajv2020['compile']> {
  const ajv = contractAjv()
  return ajv.compile(contractSchema('v4', schemaName) as AnySchemaObject)
}

test('shared v4 contract fixtures match JSON schemas', () => {
  const ajv = contractAjv()
  const validators = new Map<string, ReturnType<Ajv2020['compile']>>()

  for (const [fixtureName, schemaName] of fixtureSchemas()) {
    let validate = validators.get(schemaName)
    if (validate === undefined) {
      validate = ajv.compile(contractSchema('v4', schemaName) as AnySchemaObject)
      validators.set(schemaName, validate)
    }
    const valid = validate(contractFixture('v4', fixtureName))

    assert.equal(
      valid,
      true,
      `${fixtureName} failed ${schemaName}: ${ajv.errorsText(validate.errors)}`
    )
  }
})

test('shared v4 contract fixture manifest covers fixture and schema files', () => {
  const schemaFixtures = new Map(fixtureSchemas())
  const fixtureNames = contractFixtureFiles('v4').filter((name) => name !== 'manifest.json')
  const schemaNames = new Set(contractSchemaFiles('v4'))

  assert.deepEqual([...schemaFixtures.keys()].sort(), fixtureNames)
  assert.ok([...schemaFixtures.values()].every((schemaName) => schemaNames.has(schemaName)))
})

test('v4 pull request input schema requires audit objective', () => {
  const validate = contractValidator('pull-request-review-input.schema.json')
  const payload = contractFixture('v4', 'pull-request-review-input.json') as {
    review_intent: { objective: string }
  }
  payload.review_intent.objective = 'repair'

  assert.equal(validate(payload), false)
})

test('v4 repository input schema requires audit objective', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = contractFixture('v4', 'repository-review-input-incremental.json') as {
    review_intent: { objective: string }
  }
  payload.review_intent.objective = 'repair'

  assert.equal(validate(payload), false)
})

test('v4 repository full scan schema rejects incremental window fields', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = contractFixture('v4', 'repository-review-input-full.json') as {
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

  assert.equal(validate(payload), false)
})

test('v4 repository incremental schema rejects missing window fields', () => {
  const validate = contractValidator('repository-review-input.schema.json')

  for (const scanTargetPatch of [{ base_sha: null }, { commit_shas: [] }]) {
    const payload = structuredClone(contractFixture('v4', 'repository-review-input-incremental.json')) as {
      scan_target: {
        base_sha: string | null
        commit_shas: string[]
      }
    }
    Object.assign(payload.scan_target, scanTargetPatch)

    assert.equal(validate(payload), false, JSON.stringify(scanTargetPatch))
  }
})

test('v4 repository incremental schema allows empty changed file scope', () => {
  const validate = contractValidator('repository-review-input.schema.json')
  const payload = structuredClone(contractFixture('v4', 'repository-review-input-incremental.json')) as {
    scan_scope: {
      incremental_changed_files: Array<Record<string, unknown>>
    }
  }
  payload.scan_scope.incremental_changed_files = []

  assert.equal(validate(payload), true)
})

test('v4 review record schema rejects unsafe file change paths', () => {
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
    const payload = structuredClone(contractFixture('v4', 'review-record-deleted-file.json')) as {
      mitigation: {
        file_changes: Array<{ path: string }>
      }
    }
    const [fileChange] = payload.mitigation.file_changes
    assert.ok(fileChange)
    fileChange.path = path

    assert.equal(validate(payload), false, `${path} should not be schema-valid`)
  }
})
