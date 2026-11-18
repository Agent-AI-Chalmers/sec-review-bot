import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'
import { build } from 'vite'

test('scenario generation and validation have a browser-compatible dependency graph', async () => {
  // Preserve entry exports so unused paths cannot hide a forbidden dependency.
  // This follows transitive imports through the bundler instead of matching source text.
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'mock-api-browser-boundary',
        enforce: 'pre',
        resolveId(source) {
          if (isBuiltin(source) || source === 'vite' || source.startsWith('vite/')) {
            throw new Error(`Scenario data must not depend on ${source}`)
          }
        },
        load(id) {
          if (/\/mock-api\/(?:index|router|(?:runs|memory)\/routes)\.ts$/.test(id)) {
            throw new Error(`Scenario data must not depend on server integration: ${id}`)
          }
        }
      }
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: {
          generate: fileURLToPath(new URL('../../mock-api/runs/generate.ts', import.meta.url)),
          validate: fileURLToPath(new URL('../../mock-api/runs/validate.ts', import.meta.url))
        },
        preserveEntrySignatures: 'strict'
      }
    }
  })
  const bundles = Array.isArray(result) ? result : [result]
  const modules = bundles.flatMap((bundle) => {
    if (!('output' in bundle)) {
      throw new Error('Expected a completed browser build')
    }
    return bundle.output.flatMap((item) => (item.type === 'chunk' ? Object.keys(item.modules) : []))
  })
  expect(modules.some((id) => id.endsWith('/mock-api/runs/generate.ts'))).toBe(true)
  expect(
    modules.filter((id) => /\/mock-api\/(?:index|router|(?:runs|memory)\/routes)\.ts$/.test(id))
  ).toStrictEqual([])
})
