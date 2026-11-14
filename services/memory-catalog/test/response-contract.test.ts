import { CATALOG_CONTRACT_ROOT } from './contract-fixtures.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import Fastify from 'fastify'
import { parse } from 'yaml'

import { registerResponseValidation } from '../src/response-validation.js'
import { createApp } from '../src/server.js'
import type { MemoryCatalogStore } from '../src/catalog-store.js'
import {
  contractFixture,
  contractFixtureManifest,
  contractFixtureNames,
} from './contract-fixtures.js'

const document = parse(
  readFileSync(path.join(CATALOG_CONTRACT_ROOT, 'openapi.yaml'), 'utf8'),
) as { components: { schemas: Record<string, object> } }
const defs = JSON.parse(
  JSON.stringify(document.components.schemas).replaceAll(
    '#/components/schemas/',
    '#/$defs/',
  ),
) as Record<string, object>
const manifest = contractFixtureManifest()

await test('shared fixtures cover every schema and all files exactly once', () => {
  const names = [
    ...Object.keys(manifest.schema_fixtures),
    ...Object.keys(manifest.invalid_schema_fixtures),
  ]
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(names.sort(), contractFixtureNames())
  assert.deepEqual(
    [...new Set(Object.values(manifest.schema_fixtures))].sort(),
    Object.keys(defs).sort(),
  )
  assert.deepEqual(
    [...new Set(Object.values(manifest.invalid_schema_fixtures))].sort(),
    Object.keys(defs).sort(),
  )
})

await test('response object validation accepts and rejects the shared schema cases', async () => {
  const app = Fastify()
  registerResponseValidation(app)
  let value: unknown
  for (const schema of Object.keys(defs)) {
    app.get(
      `/fixture/${schema}`,
      {
        schema: {
          response: {
            200: {
              $defs: defs,
              type: 'object',
              required: ['value'],
              properties: { value: { $ref: `#/$defs/${schema}` } },
            },
          },
        },
      },
      () => Promise.resolve({ value }),
    )
  }
  try {
    for (const [cases, valid] of [
      [manifest.schema_fixtures, true],
      [manifest.invalid_schema_fixtures, false],
    ] as const) {
      for (const [name, schema] of Object.entries(cases)) {
        value = contractFixture(name)
        const response = await app.inject(`/fixture/${schema}`)
        assert.equal(response.statusCode, valid ? 200 : 500, name)
        if (valid) assert.deepEqual(response.json(), { value }, name)
      }
    }
  } finally {
    await app.close()
  }
})

await test('actual catalog routes reject malformed query results before emitting success', async () => {
  let value: unknown
  // Deliberately allow corrupt store output: this test protects the HTTP exit, not TS types.
  const store = {
    queries: {
      getMemoryTree: () => Promise.resolve(value),
      getMemoryTreeAutomation: () => Promise.resolve(value),
      getObservationBacklog: () => Promise.resolve(value),
    },
  } as unknown as MemoryCatalogStore
  const app = await createApp({
    store,
    workerToken: 'worker',
    operatorToken: 'operator',
  })
  try {
    for (const [schema, url] of [
      ['MemoryTree', '/v1/memory-tree'],
      ['MemoryTreeAutomation', '/v1/memory-tree/automation'],
      ['ObservationBacklog', '/v1/observation-backlog'],
    ]) {
      for (const [cases, valid] of [
        [manifest.schema_fixtures, true],
        [manifest.invalid_schema_fixtures, false],
      ] as const) {
        for (const [name, caseSchema] of Object.entries(cases)) {
          if (caseSchema !== schema) continue
          value = contractFixture(name)
          // Catalog handlers produce response objects; pre-serialized payloads are outside
          // this hook's scope. Nested values remain covered by the shared schema cases.
          if (value === null || typeof value !== 'object') continue
          const response = await app.inject({
            method: 'GET',
            url: url!,
            headers: { authorization: 'Bearer worker' },
          })
          assert.equal(response.statusCode, valid ? 200 : 500, name)
          if (valid) assert.deepEqual(response.json(), value, name)
          else
            assert.deepEqual(
              response.json(),
              { error: 'Internal server error', code: 'INTERNAL_ERROR' },
              name,
            )
        }
      }
    }
  } finally {
    await app.close()
  }
})

await test('actual write routes reject shared malformed requests before reaching the store', async () => {
  let calls = 0
  const store = {
    registerExtraction: () => {
      calls++
      return Promise.resolve(true)
    },
    changeMemoryTreeAutomation: () => {
      calls++
      return Promise.resolve(
        contractFixture('valid-memory-tree-automation-operation-result.json'),
      )
    },
    restoreMemoryTree: () => {
      calls++
      return Promise.resolve(
        contractFixture('valid-memory-tree-restore-operation-result.json'),
      )
    },
    abandonRevisionPublications: () => {
      calls++
      return Promise.resolve([])
    },
    reserveExtractionPublication: () => {
      calls++
      return Promise.resolve(
        contractFixture('valid-extraction-publication.json'),
      )
    },
    createMemoryTreeRevision: () => {
      calls++
      return Promise.resolve(
        contractFixture('valid-memory-tree-revision-creation-result.json'),
      )
    },
    reserveRevisionPublication: () => {
      calls++
      return Promise.resolve(contractFixture('valid-revision-publication.json'))
    },
  } as unknown as MemoryCatalogStore
  const app = await createApp({
    store,
    workerToken: 'worker',
    operatorToken: 'operator',
  })
  const routes = [
    ['ExtractionRegistration', '/v1/extractions', 'worker'],
    [
      'MemoryTreeAutomationOperation',
      '/v1/memory-tree/automation/pause',
      'operator',
    ],
    ['MemoryTreeRestoreOperation', '/v1/memory-tree/restore', 'operator'],
    [
      'AutomaticRevisionPublicationOwner',
      '/v1/memory-tree/revisions/publications/abandon',
      'worker',
    ],
    [
      'ExtractionPublicationIntent',
      '/v1/extractions/publications/reserve',
      'worker',
    ],
    ['MemoryTreeRevisionCreation', '/v1/memory-tree/revisions', 'worker'],
    [
      'MemoryTreeRevisionCreation',
      '/v1/memory-tree/revisions/publications/reserve',
      'worker',
    ],
  ] as const
  try {
    for (const [schema, url, token] of routes) {
      for (const [cases, valid] of [
        [manifest.schema_fixtures, true],
        [manifest.invalid_schema_fixtures, false],
      ] as const) {
        for (const [name, caseSchema] of Object.entries(cases)) {
          if (caseSchema !== schema) continue
          const payload = contractFixture(name)
          const source = (payload as { source?: { kind?: string } }).source
          const role = source?.kind === 'manual' ? 'operator' : token
          const before = calls
          const response = await app.inject({
            method: 'POST',
            url,
            headers: {
              authorization: `Bearer ${role}`,
              'content-type': 'application/json',
            },
            payload: JSON.stringify(payload),
          })
          if (valid) {
            assert.ok(
              response.statusCode === 200 || response.statusCode === 201,
              `${name}: ${response.body}`,
            )
            assert.equal(calls, before + 1, name)
          } else {
            assert.equal(response.statusCode, 400, name)
            assert.equal(calls, before, name)
          }
        }
      }
    }
  } finally {
    await app.close()
  }
})
