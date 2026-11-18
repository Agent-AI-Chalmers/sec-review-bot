import { CATALOG_CONTRACT_ROOT } from './contract-fixtures.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

import Fastify from 'fastify'
import { parse } from 'yaml'

import { registerResponseValidation } from '../src/response-validation.js'
import { createApp } from '../src/server.js'
import type { MemoryCatalogStore } from '../src/catalog-store.js'
import {
  contractFixture,
  contractFixtureManifest,
  contractFixtureNames
} from './contract-fixtures.js'

const document = parse(readFileSync(path.join(CATALOG_CONTRACT_ROOT, 'openapi.yaml'), 'utf8')) as {
  components: { schemas: Record<string, object> }
}
const defs = JSON.parse(
  JSON.stringify(document.components.schemas).replaceAll('#/components/schemas/', '#/$defs/')
) as Record<string, object>
const manifest = contractFixtureManifest()

test('shared fixtures cover every schema and all files exactly once', () => {
  const names = [
    ...Object.keys(manifest.schema_fixtures),
    ...Object.keys(manifest.invalid_schema_fixtures)
  ]
  expect(new Set(names).size).toBe(names.length)
  expect(names.sort()).toStrictEqual(contractFixtureNames())
  expect([...new Set(Object.values(manifest.schema_fixtures))].sort()).toStrictEqual(
    Object.keys(defs).sort()
  )
  expect([...new Set(Object.values(manifest.invalid_schema_fixtures))].sort()).toStrictEqual(
    Object.keys(defs).sort()
  )
})

test('response object validation accepts and rejects the shared schema cases', async () => {
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
              properties: { value: { $ref: `#/$defs/${schema}` } }
            }
          }
        }
      },
      () => Promise.resolve({ value })
    )
  }
  try {
    for (const [cases, valid] of [
      [manifest.schema_fixtures, true],
      [manifest.invalid_schema_fixtures, false]
    ] as const) {
      for (const [name, schema] of Object.entries(cases)) {
        value = contractFixture(name)
        const response = await app.inject(`/fixture/${schema}`)
        expect(response.statusCode, name).toBe(valid ? 200 : 500)
        if (valid) {
          expect(response.json(), name).toStrictEqual({ value })
        }
      }
    }
  } finally {
    await app.close()
  }
})

test('actual catalog routes reject malformed query results before emitting success', async () => {
  let value: unknown
  // Deliberately allow corrupt store output: this test protects the HTTP exit, not TS types.
  const store = {
    queries: {
      getMemoryTree: () => Promise.resolve(value),
      getMemoryTreeAutomation: () => Promise.resolve(value),
      getObservationBacklog: () => Promise.resolve(value)
    }
  } as unknown as MemoryCatalogStore
  const app = await createApp({
    store,
    workerToken: 'worker',
    operatorToken: 'operator'
  })
  try {
    for (const [schema, url] of [
      ['MemoryTree', '/v1/memory-tree'],
      ['MemoryTreeAutomation', '/v1/memory-tree/automation'],
      ['ObservationBacklog', '/v1/observation-backlog']
    ]) {
      for (const [cases, valid] of [
        [manifest.schema_fixtures, true],
        [manifest.invalid_schema_fixtures, false]
      ] as const) {
        for (const [name, caseSchema] of Object.entries(cases)) {
          if (caseSchema !== schema) {
            continue
          }
          value = contractFixture(name)
          // Catalog handlers produce response objects; pre-serialized payloads are outside
          // this hook's scope. Nested values remain covered by the shared schema cases.
          if (value === null || typeof value !== 'object') {
            continue
          }
          const response = await app.inject({
            method: 'GET',
            url: url!,
            headers: { authorization: 'Bearer worker' }
          })
          expect(response.statusCode, name).toBe(valid ? 200 : 500)
          if (valid) {
            expect(response.json(), name).toStrictEqual(value)
          } else {
            expect(response.json(), name).toStrictEqual({
              error: 'Internal server error',
              code: 'INTERNAL_ERROR'
            })
          }
        }
      }
    }
  } finally {
    await app.close()
  }
})

test('actual write routes reject shared malformed requests before reaching the store', async () => {
  let calls = 0
  const store = {
    registerExtraction: () => {
      calls++
      return Promise.resolve(true)
    },
    changeMemoryTreeAutomation: () => {
      calls++
      return Promise.resolve(contractFixture('valid-memory-tree-automation-operation-result.json'))
    },
    restoreMemoryTree: () => {
      calls++
      return Promise.resolve(contractFixture('valid-memory-tree-restore-operation-result.json'))
    },
    abandonVersionPublications: () => {
      calls++
      return Promise.resolve([])
    },
    reserveExtractionPublication: () => {
      calls++
      return Promise.resolve(contractFixture('valid-extraction-publication.json'))
    },
    createMemoryTreeVersion: () => {
      calls++
      return Promise.resolve(contractFixture('valid-memory-tree-version-creation-result.json'))
    },
    reserveVersionPublication: () => {
      calls++
      return Promise.resolve(contractFixture('valid-version-publication.json'))
    }
  } as unknown as MemoryCatalogStore
  const app = await createApp({
    store,
    workerToken: 'worker',
    operatorToken: 'operator'
  })
  const routes = [
    ['ExtractionRegistration', '/v1/extractions', 'worker'],
    ['MemoryTreeAutomationOperation', '/v1/memory-tree/automation/pause', 'operator'],
    ['MemoryTreeRestoreOperation', '/v1/memory-tree/restore', 'operator'],
    ['AutomaticVersionPublicationOwner', '/v1/memory-tree/versions/publications/abandon', 'worker'],
    ['ExtractionPublicationIntent', '/v1/extractions/publications/reserve', 'worker'],
    ['MemoryTreeVersionCreation', '/v1/memory-tree/versions', 'worker'],
    ['MemoryTreeVersionCreation', '/v1/memory-tree/versions/publications/reserve', 'worker']
  ] as const
  try {
    for (const [schema, url, token] of routes) {
      for (const [cases, valid] of [
        [manifest.schema_fixtures, true],
        [manifest.invalid_schema_fixtures, false]
      ] as const) {
        for (const [name, caseSchema] of Object.entries(cases)) {
          if (caseSchema !== schema) {
            continue
          }
          const payload = contractFixture(name)
          const source = (payload as { source?: { kind?: string } }).source
          const role = source?.kind === 'manual' ? 'operator' : token
          const before = calls
          const response = await app.inject({
            method: 'POST',
            url,
            headers: {
              authorization: `Bearer ${role}`,
              'content-type': 'application/json'
            },
            payload: JSON.stringify(payload)
          })
          if (valid) {
            expect.assert(
              response.statusCode === 200 || response.statusCode === 201,
              `${name}: ${response.body}`
            )
            expect(calls, name).toBe(before + 1)
          } else {
            expect(response.statusCode, name).toBe(400)
            expect(calls, name).toBe(before)
          }
        }
      }
    }
  } finally {
    await app.close()
  }
})

test('obsolete version fields and history routes are rejected without reaching storage', async () => {
  let calls = 0
  const store = {
    changeMemoryTreeAutomation: () => {
      calls++
      throw new Error('unexpected write')
    },
    createMemoryTreeVersion: () => {
      calls++
      throw new Error('unexpected write')
    },
    queries: {
      listMemoryTreeVersions: () => {
        calls++
        throw new Error('unexpected read')
      }
    }
  } as unknown as MemoryCatalogStore
  const app = await createApp({
    store,
    workerToken: 'worker',
    operatorToken: 'operator'
  })
  try {
    const automation = await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/automation/pause',
      headers: { authorization: 'Bearer operator' },
      payload: { operation_id: 'pause-old', expected_generation: 0 }
    })
    expect(automation.statusCode).toBe(400)
    const { expected_active_version, ...creation } = contractFixture(
      'valid-memory-tree-version-creation.json'
    ) as Record<string, unknown>
    const oldCreation = await app.inject({
      method: 'POST',
      url: '/v1/memory-tree/versions',
      headers: { authorization: 'Bearer worker' },
      payload: {
        ...creation,
        expected_active_revision: expected_active_version
      }
    })
    expect(oldCreation.statusCode).toBe(400)
    const history = await app.inject({
      method: 'GET',
      url: '/v1/memory-tree/revisions',
      headers: { authorization: 'Bearer worker' }
    })
    expect(history.statusCode).toBe(404)
    expect(calls).toBe(0)
  } finally {
    await app.close()
  }
})
